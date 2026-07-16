"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = require("dotenv");
const core_1 = require("@nestjs/core");
const app_module_1 = require("../src/app.module");
const products_service_1 = require("../src/products/products.service");
(0, dotenv_1.config)({ override: true });
const productIds = process.argv
    .slice(2)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
if (!productIds.length) {
    console.error('Usage: ts-node -r tsconfig-paths/register scripts/sync-products-typesense.ts <productId...>');
    process.exit(1);
}
async function main() {
    const app = await core_1.NestFactory.createApplicationContext(app_module_1.AppModule, {
        logger: ['error', 'warn', 'log'],
    });
    try {
        const productsService = app.get(products_service_1.ProductsService);
        await productsService.syncProductsToTypesense(productIds);
        console.log('TYPESENSE_SYNC_OK', productIds);
    }
    finally {
        await app.close();
    }
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
//# sourceMappingURL=sync-products-typesense.js.map