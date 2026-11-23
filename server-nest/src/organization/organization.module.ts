import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { GeocodeModule } from '../geocode/geocode.module.js';
import { ManagerShopsController } from './manager-shops.controller.js';
import { ScopeService } from './scope.service.js';
import { ShopsController } from './shops.controller.js';
import { ShopsService } from './shops.service.js';

@Global()
@Module({
  imports: [AuthModule, GeocodeModule],
  controllers: [ShopsController, ManagerShopsController],
  providers: [ScopeService, ShopsService],
  exports: [ScopeService],
})
export class OrganizationModule {}
