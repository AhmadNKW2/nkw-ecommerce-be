import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TermGroup } from '../terms/entities/term-group.entity';
import { normalizeSearchQuery } from '../typesense/utils/text-normalize';
import {
  buildConceptSynonymVariants,
  normalizeConceptTermKey,
  type SearchLocale,
} from './utils/spec-expansion.utils';

export type MatchedConceptInQuery = {
  groupId: number;
  conceptKey: string;
  userTerm: string;
  matchedTokens: string[];
  orderedVariants: string[];
  matchStart: number;
};

type LexiconPhraseEntry = {
  groupId: number;
  conceptKey: string;
  phrase: string;
  normalizedPhrase: string;
  tokenCount: number;
  group: TermGroup;
};

type LexiconSegmentEntry = {
  groupId: number;
  conceptKey: string;
  group: TermGroup;
  matchedTerm: string;
};

@Injectable()
export class TermConceptLexiconService {
  private lexiconCache:
    | {
        loadedAt: number;
        phraseEntries: LexiconPhraseEntry[];
        tokenEntries: Array<{
          groupId: number;
          conceptKey: string;
          token: string;
          normalizedToken: string;
          group: TermGroup;
        }>;
        segmentToGroups: Map<string, LexiconSegmentEntry[]>;
      }
    | null = null;

  private readonly cacheTtlMs = 5 * 60 * 1000;

  constructor(
    @InjectRepository(TermGroup)
    private readonly termGroupsRepository: Repository<TermGroup>,
  ) {}

  async resolveAllConceptsInQuery(
    normalizedQuery: string,
    tokens: string[],
    locale: SearchLocale,
  ): Promise<MatchedConceptInQuery[]> {
    const lexicon = await this.getLexicon();
    const query = normalizeSearchQuery(normalizedQuery).trim();
    if (!query) {
      return [];
    }

    const paddedQuery = ` ${query} `;
    const coveredTokenIndexes = new Set<number>();
    const matchedGroupIds = new Set<number>();
    const matches: MatchedConceptInQuery[] = [];

    for (const entry of lexicon.phraseEntries) {
      if (matchedGroupIds.has(entry.groupId)) {
        continue;
      }

      const needle = ` ${entry.normalizedPhrase} `;
      if (!needle.trim() || !paddedQuery.includes(needle)) {
        continue;
      }

      let searchFrom = 0;
      while (searchFrom < paddedQuery.length) {
        const matchIndex = paddedQuery.indexOf(needle, searchFrom);
        if (matchIndex === -1) {
          break;
        }

        const spanStart = matchIndex;
        const spanEnd = matchIndex + needle.length;
        const tokenIndexes = this.getTokenIndexesForSpan(
          query,
          spanStart - 1,
          spanEnd - 1,
          tokens,
        );

        const overlapsExisting = [...coveredTokenIndexes].some((index) =>
          tokenIndexes.includes(index),
        );
        if (!overlapsExisting) {
          const queryStart = Math.max(0, spanStart - 1);
          const queryEnd = Math.max(queryStart, spanEnd - 1);
          const userTerm = query.slice(queryStart, queryEnd).trim();
          tokenIndexes.forEach((index) => coveredTokenIndexes.add(index));
          matchedGroupIds.add(entry.groupId);
          matches.push({
            groupId: entry.groupId,
            conceptKey: entry.conceptKey,
            userTerm,
            matchedTokens: tokenIndexes.map((index) => tokens[index]).filter(Boolean),
            orderedVariants: buildConceptSynonymVariants(userTerm, entry.group, locale),
            matchStart: queryStart,
          });
          break;
        }

        searchFrom = matchIndex + 1;
      }
    }

    tokens.forEach((token, index) => {
      if (coveredTokenIndexes.has(index)) {
        return;
      }

      const normalizedToken = normalizeConceptTermKey(token);
      if (!normalizedToken) {
        return;
      }

      for (const entry of lexicon.tokenEntries) {
        if (matchedGroupIds.has(entry.groupId)) {
          continue;
        }
        if (entry.normalizedToken !== normalizedToken) {
          continue;
        }

        coveredTokenIndexes.add(index);
        matchedGroupIds.add(entry.groupId);
        matches.push({
          groupId: entry.groupId,
          conceptKey: entry.conceptKey,
          userTerm: token.trim(),
          matchedTokens: [token.trim()],
          orderedVariants: buildConceptSynonymVariants(token.trim(), entry.group, locale),
          matchStart: this.getTokenStartOffset(query, tokens, index),
        });
        break;
      }
    });

    return matches.sort((left, right) => left.matchStart - right.matchStart);
  }

  async resolveAllConceptGroupsMatchingSegment(
    segment: string,
    locale: SearchLocale,
  ): Promise<MatchedConceptInQuery[]> {
    const lexicon = await this.getLexicon();
    const normalizedSegment = normalizeSearchQuery(segment).trim();
    if (!normalizedSegment) {
      return [];
    }

    const entries = lexicon.segmentToGroups.get(normalizedSegment) ?? [];
    const userTerm = segment.trim() || normalizedSegment;

    return entries.map((entry, index) => ({
      groupId: entry.groupId,
      conceptKey: entry.conceptKey,
      userTerm,
      matchedTokens: normalizedSegment.split(/\s+/).filter(Boolean),
      orderedVariants: buildConceptSynonymVariants(userTerm, entry.group, locale),
      matchStart: index,
    }));
  }

  getConceptTokensFromMatches(matches: MatchedConceptInQuery[]): Set<string> {
    const tokens = new Set<string>();
    matches.forEach((match) => {
      match.matchedTokens.forEach((token) => {
        const trimmed = token.trim();
        if (trimmed) {
          tokens.add(trimmed);
        }
      });
    });
    return tokens;
  }

  private async getLexicon(): Promise<NonNullable<TermConceptLexiconService['lexiconCache']>> {
    const now = Date.now();
    if (this.lexiconCache && now - this.lexiconCache.loadedAt < this.cacheTtlMs) {
      return this.lexiconCache;
    }

    const groups = await this.termGroupsRepository.find();
    const phraseEntries: LexiconPhraseEntry[] = [];
    const tokenEntries: Array<{
      groupId: number;
      conceptKey: string;
      token: string;
      normalizedToken: string;
      group: TermGroup;
    }> = [];
    const segmentToGroups = new Map<string, LexiconSegmentEntry[]>();
    const seenPhraseKeys = new Set<string>();
    const seenTokenKeys = new Set<string>();

    const pushSegmentGroup = (
      normalizedSegment: string,
      entry: LexiconSegmentEntry,
    ) => {
      const existing = segmentToGroups.get(normalizedSegment) ?? [];
      if (existing.some((item) => item.groupId === entry.groupId)) {
        return;
      }
      existing.push(entry);
      segmentToGroups.set(normalizedSegment, existing);
    };

    groups.forEach((group) => {
      const conceptKey = group.concept_key?.trim() || `group-${group.id}`;
      const phrases = [
        ...(group.terms_en ?? []),
        ...(group.terms_ar ?? []),
        group.concept_label_en,
        group.concept_label_ar,
        group.concept_key,
      ]
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean);

      phrases.forEach((phrase) => {
        const normalizedPhrase = normalizeSearchQuery(phrase).trim();
        if (!normalizedPhrase) {
          return;
        }

        pushSegmentGroup(normalizedPhrase, {
          groupId: group.id,
          conceptKey,
          group,
          matchedTerm: phrase,
        });

        const tokenCount = normalizedPhrase.split(/\s+/).filter(Boolean).length;
        const phraseKey = `${group.id}:${normalizedPhrase}`;
        if (seenPhraseKeys.has(phraseKey)) {
          return;
        }
        seenPhraseKeys.add(phraseKey);

        const entry: LexiconPhraseEntry = {
          groupId: group.id,
          conceptKey,
          phrase,
          normalizedPhrase,
          tokenCount,
          group,
        };

        if (tokenCount > 1) {
          phraseEntries.push(entry);
        } else {
          const tokenKey = `${group.id}:${normalizedPhrase}`;
          if (!seenTokenKeys.has(tokenKey)) {
            seenTokenKeys.add(tokenKey);
            tokenEntries.push({
              groupId: group.id,
              conceptKey,
              token: phrase,
              normalizedToken: normalizedPhrase,
              group,
            });
          }
        }
      });
    });

    phraseEntries.sort((left, right) => {
      if (right.normalizedPhrase.length !== left.normalizedPhrase.length) {
        return right.normalizedPhrase.length - left.normalizedPhrase.length;
      }
      return right.tokenCount - left.tokenCount;
    });

    this.lexiconCache = {
      loadedAt: now,
      phraseEntries,
      tokenEntries,
      segmentToGroups,
    };

    return this.lexiconCache;
  }

  private getTokenIndexesForSpan(
    query: string,
    spanStart: number,
    spanEnd: number,
    tokens: string[],
  ): number[] {
    const indexes: number[] = [];
    let cursor = 0;

    tokens.forEach((token, index) => {
      const trimmed = token.trim();
      if (!trimmed) {
        return;
      }

      while (cursor < query.length && query[cursor] === ' ') {
        cursor += 1;
      }

      const tokenStart = cursor;
      const tokenEnd = tokenStart + trimmed.length;
      if (tokenEnd > spanStart && tokenStart < spanEnd) {
        indexes.push(index);
      }

      cursor = tokenEnd;
    });

    return indexes;
  }

  private getTokenStartOffset(
    query: string,
    tokens: string[],
    tokenIndex: number,
  ): number {
    let cursor = 0;

    for (let index = 0; index < tokens.length; index += 1) {
      const trimmed = tokens[index].trim();
      if (!trimmed) {
        continue;
      }

      while (cursor < query.length && query[cursor] === ' ') {
        cursor += 1;
      }

      if (index === tokenIndex) {
        return cursor;
      }

      cursor += trimmed.length;
    }

    return query.length;
  }
}
