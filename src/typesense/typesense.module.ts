import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Typesense from 'typesense';
import { TYPESENSE_CLIENT } from './typesense.constants';
import { TypesenseService } from './typesense.service';
import { TermConceptSynonymSyncService } from './term-concept-synonym-sync.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: TYPESENSE_CLIENT,
      useFactory: (configService: ConfigService) =>
        new Typesense.Client({
          nodes: [
            {
              host: configService.get<string>('TYPESENSE_HOST', 'localhost'),
              port: Number(configService.get<string>('TYPESENSE_PORT', '8108')),
              protocol: configService.get<string>('TYPESENSE_PROTOCOL', 'http'),
            },
          ],
          apiKey: configService.get<string>('TYPESENSE_API_KEY', ''),
          connectionTimeoutSeconds: Number(
            configService.get<string>('TYPESENSE_TIMEOUT_SECONDS', '5'),
          ),
        }),
      inject: [ConfigService],
    },
    TypesenseService,
    TermConceptSynonymSyncService,
  ],
  exports: [TYPESENSE_CLIENT, TypesenseService, TermConceptSynonymSyncService],
})
export class TypesenseModule {}
