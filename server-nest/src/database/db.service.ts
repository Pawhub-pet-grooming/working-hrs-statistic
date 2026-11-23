import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../generated/prisma/client.js';
import type { Env } from '../config/env.schema.js';

@Injectable()
export class DbService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);

  constructor(config: ConfigService<Env, true>) {
    const connectionString =
      config.get('TEST_DATABASE_URL', { infer: true }) ?? config.get('DATABASE_URL', { infer: true });
    super({ adapter: new PrismaPg({ connectionString }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Disconnected from the database');
  }
}

/** Accepted by helpers that run either outside a transaction (DbService) or inside one. */
export type Queryable = DbService | Prisma.TransactionClient;
