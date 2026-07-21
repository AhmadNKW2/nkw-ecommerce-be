import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { appendFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { Attribute } from '../attributes/entities/attribute.entity';
import { Brand } from '../brands/entities/brand.entity';
import { Specification } from '../specifications/entities/specification.entity';
import { buildProductImportSystemPrompt } from '../products/prompts/product-import-system.prompt';
import {
  buildStage1SystemPrompt,
  Stage1CategoryNode,
} from './prompts/stage1-classifier.prompt';

export interface Stage1SubmissionInput {
  title: string;
  description: string;
}

export interface Stage1SuggestedBrand {
  name_en: string;
  name_ar: string;
}

export interface Stage1SuggestedCategory {
  name_en: string;
  name_ar: string;
  parent_id: number | null;
  reason?: string;
}

export interface Stage1Result {
  brand_match: string | null;
  suggested_brand: Stage1SuggestedBrand | null;
  category_match: number | null;
  suggested_category: Stage1SuggestedCategory | null;
}

export interface Stage2AiValue {
  original_value: unknown;
  matched_value_id: number | 'not_exist';
}

export interface Stage2AiSpecification {
  specification_id: number;
  values: Stage2AiValue[];
}

export interface Stage2AiAttribute {
  attribute: { attribute_id: number; original_value?: unknown };
  values: Stage2AiValue[];
}

export interface Stage2Result {
  brand_name?: unknown;
  title_en?: unknown;
  title_ar?: unknown;
  meta_title_en?: unknown;
  meta_title_ar?: unknown;
  short_description_en?: unknown;
  short_description_ar?: unknown;
  description_en?: unknown;
  description_ar?: unknown;
  meta_description_en?: unknown;
  meta_description_ar?: unknown;
  weight?: unknown;
  weight_unit?: unknown;
  length?: unknown;
  width?: unknown;
  height?: unknown;
  dimension_unit?: unknown;
  specifications?: Stage2AiSpecification[];
  attributes?: Stage2AiAttribute[];
}

interface OpenAiInputMessage {
  role: 'system' | 'user';
  content: string;
}

@Injectable()
export class VendorSubmissionAiService {
  private readonly logger = new Logger(VendorSubmissionAiService.name);

  private getOpenAiApiKey(): string {
    const key = process.env.OPENAI_API_KEY?.trim();
    if (!key) {
      throw new BadRequestException('Missing OPENAI_API_KEY environment variable.');
    }
    return key;
  }

  private getStage1Model(): string {
    return (
      process.env.VENDOR_SUBMISSION_STAGE1_MODEL?.trim() ||
      process.env.OPENAI_MODEL?.trim() ||
      'gpt-5.6-terra'
    );
  }

  private getStage2Model(): string {
    return (
      process.env.VENDOR_SUBMISSION_STAGE2_MODEL?.trim() ||
      process.env.OPENAI_MODEL?.trim() ||
      'gpt-5.6-terra'
    );
  }

  async classify(
    payload: Stage1SubmissionInput,
    brands: Pick<Brand, 'id' | 'name_en'>[],
    categories: Stage1CategoryNode[],
  ): Promise<Stage1Result> {
    const model = this.getStage1Model();
    const input: OpenAiInputMessage[] = [
      { role: 'system', content: buildStage1SystemPrompt({ brands, categories }) },
      { role: 'user', content: JSON.stringify(payload, null, 2) },
    ];

    const parsed = await this.callOpenAi(model, input, 'stage1');
    return this.normalizeStage1(parsed);
  }

  async enrich(
    payload: Stage1SubmissionInput & { price?: number; stock?: number },
    catalog: {
      brands: Brand[];
      specifications: Specification[];
      attributes: Attribute[];
    },
  ): Promise<Stage2Result> {
    const model = this.getStage2Model();
    const input: OpenAiInputMessage[] = [
      { role: 'system', content: buildProductImportSystemPrompt(catalog) },
      { role: 'user', content: JSON.stringify(payload, null, 2) },
    ];

    const parsed = await this.callOpenAi(model, input, 'stage2');
    return parsed as Stage2Result;
  }

  private normalizeStage1(parsed: Record<string, unknown>): Stage1Result {
    const brandMatch =
      typeof parsed.brand_match === 'string' && parsed.brand_match.trim()
        ? parsed.brand_match.trim()
        : null;

    const suggestedBrandRaw = parsed.suggested_brand as
      | Record<string, unknown>
      | null
      | undefined;
    const suggestedBrand: Stage1SuggestedBrand | null =
      suggestedBrandRaw && typeof suggestedBrandRaw.name_en === 'string'
        ? {
            name_en: String(suggestedBrandRaw.name_en).trim(),
            name_ar:
              typeof suggestedBrandRaw.name_ar === 'string' &&
              suggestedBrandRaw.name_ar.trim()
                ? String(suggestedBrandRaw.name_ar).trim()
                : String(suggestedBrandRaw.name_en).trim(),
          }
        : null;

    const categoryMatch = Number(parsed.category_match);
    const resolvedCategoryMatch =
      Number.isInteger(categoryMatch) && categoryMatch > 0 ? categoryMatch : null;

    const suggestedCategoryRaw = parsed.suggested_category as
      | Record<string, unknown>
      | null
      | undefined;
    let suggestedCategory: Stage1SuggestedCategory | null = null;
    if (
      suggestedCategoryRaw &&
      typeof suggestedCategoryRaw.name_en === 'string' &&
      suggestedCategoryRaw.name_en.trim()
    ) {
      const parentId = Number(suggestedCategoryRaw.parent_id);
      suggestedCategory = {
        name_en: String(suggestedCategoryRaw.name_en).trim(),
        name_ar:
          typeof suggestedCategoryRaw.name_ar === 'string' &&
          suggestedCategoryRaw.name_ar.trim()
            ? String(suggestedCategoryRaw.name_ar).trim()
            : String(suggestedCategoryRaw.name_en).trim(),
        parent_id:
          Number.isInteger(parentId) && parentId > 0 ? parentId : null,
        reason:
          typeof suggestedCategoryRaw.reason === 'string'
            ? String(suggestedCategoryRaw.reason)
            : undefined,
      };
    }

    return {
      brand_match: brandMatch,
      suggested_brand: brandMatch ? null : suggestedBrand,
      category_match: resolvedCategoryMatch,
      suggested_category: resolvedCategoryMatch ? null : suggestedCategory,
    };
  }

  private async callOpenAi(
    model: string,
    input: OpenAiInputMessage[],
    stage: 'stage1' | 'stage2',
  ): Promise<Record<string, unknown>> {
    const openAiKey = this.getOpenAiApiKey();
    let responseBody: unknown = null;
    let rawOutputText: string | null = null;
    let errorMessage: string | null = null;

    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openAiKey}`,
        },
        body: JSON.stringify({ model, input }),
      });

      responseBody = await response.json();
      if (!response.ok) {
        throw new Error(
          `OpenAI request failed (${response.status}): ${JSON.stringify(responseBody)}`,
        );
      }

      rawOutputText = this.stripCodeFences(this.extractOpenAiText(responseBody));
      const parsed = JSON.parse(rawOutputText) as Record<string, unknown>;
      return parsed;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Vendor submission ${stage} AI call failed: ${errorMessage}`);
      throw new BadRequestException(
        `Vendor submission AI (${stage}) failed: ${errorMessage}`,
      );
    } finally {
      await this.appendLog({
        timestamp: new Date().toISOString(),
        stage,
        model,
        input,
        response: responseBody,
        raw_output_text: rawOutputText,
        error: errorMessage,
      });
    }
  }

  private extractOpenAiText(responseBody: unknown): string {
    const body = (responseBody ?? {}) as Record<string, any>;

    if (typeof body.output_text === 'string' && body.output_text.trim()) {
      return body.output_text;
    }

    const choiceText = body.choices?.[0]?.message?.content;
    if (typeof choiceText === 'string' && choiceText.trim()) {
      return choiceText;
    }

    const output = body.output;
    if (Array.isArray(output)) {
      for (const item of output) {
        const content = item?.content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (typeof part?.text === 'string' && part.text.trim()) {
              return part.text;
            }
          }
        }
      }
    }

    throw new Error('Unable to extract text from OpenAI response.');
  }

  private stripCodeFences(text: string): string {
    return text
      .trim()
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/i, '')
      .trim();
  }

  private async appendLog(entry: Record<string, unknown>): Promise<void> {
    try {
      const logPath =
        process.env.VENDOR_SUBMISSION_OPENAI_LOG_PATH?.trim() ||
        'logs/vendor_submission_openai.jsonl';
      await mkdir(dirname(logPath), { recursive: true });
      await appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      this.logger.warn(
        `Failed to write vendor submission AI log: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
