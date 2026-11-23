import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { GeocodeModule } from '../geocode/geocode.module.js';
import { AccountsService } from './accounts.service.js';
import { ManagerAccountsController } from './manager-accounts.controller.js';
import { ManagerShopsController } from './manager-shops.controller.js';
import { OrganizationController } from './organization.controller.js';
import { OrganizationService } from './organization.service.js';
import { ScopeService } from './scope.service.js';
import { ShopsController } from './shops.controller.js';
import { ShopsService } from './shops.service.js';

@Global()
@Module({
  imports: [AuthModule, GeocodeModule],
  controllers: [ShopsController, ManagerShopsController, ManagerAccountsController, OrganizationController],
  providers: [ScopeService, ShopsService, AccountsService, OrganizationService],
  exports: [ScopeService],
})
export class OrganizationModule {}
