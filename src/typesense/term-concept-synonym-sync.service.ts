import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TermGroup } from '../terms/entities/term-group.entity';
import { PRODUCT_CONCEPT_SYNONYM_SET_NAME } from './config/synonyms';
import { TypesenseService } from './typesense.service';
import { buildTermGroupSynonymGroups } from './utils/term-group-synonyms';

@Injectable()
export class TermConceptSynonymSyncService {
  private readonly logger = new Logger(TermConceptSynonymSyncService.name);
  private syncPromise: Promise<void> | null = null;

  constructor(
    private readonly typesenseService: TypesenseService,
    private readonly configService: ConfigService,
  ) {}

  isEnabled(): boolean {
    if (!this.typesenseService.isEnabled()) {
      return false;
    }

    const raw = this.configService.get<string>(
      'SEARCH_TYPESENSE_CONCEPT_SYNONYMS',
      'true',
    );
    return raw.trim().toLowerCase() !== 'false';
  }

  async syncGroups(groups: TermGroup[]): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    if (this.syncPromise) {
      return this.syncPromise;
    }

    this.syncPromise = (async () => {
      const synonymGroups = buildTermGroupSynonymGroups(groups);
      await this.typesenseService.syncSynonymSet(
        PRODUCT_CONCEPT_SYNONYM_SET_NAME,
        synonymGroups,
      );

      this.logger.log(
        `Synced ${Object.keys(synonymGroups).length} concept synonym groups to Typesense`,
      );
    })();

    try {
      await this.syncPromise;
    } finally {
      this.syncPromise = null;
    }
  }
}
