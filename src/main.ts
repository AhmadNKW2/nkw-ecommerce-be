import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import cookieParser from 'cookie-parser';
import { types } from 'pg';

// Force the pg driver to treat TIMESTAMP WITHOUT TIME ZONE (OID 1114) as UTC.
// Without this, the pg driver uses the Node/system local timezone to parse bare
// timestamps, causing incorrect Date values when the system is not in UTC.
types.setTypeParser(1114, (val: string) => new Date(val + 'Z'));

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Trust reverse proxy headers (Render/Vercel) so req.secure can reflect HTTPS.
  // This helps when deciding cookie `secure` / `sameSite` options.
  app.set('trust proxy', 1);

  // Create upload directories if they don't exist
  const uploadDirs = [
    'uploads',
    'uploads/products',
    'uploads/categories',
    'uploads/vendors',
  ];
  uploadDirs.forEach((dir) => {
    const uploadPath = join(process.cwd(), dir);
    if (!existsSync(uploadPath)) {
      mkdirSync(uploadPath, { recursive: true });
    }
  });

  // Serve static files
  app.useStaticAssets(join(process.cwd(), 'uploads'), {
    prefix: '/uploads',
  });

  // Enable cookie parsing for HTTP-only cookie authentication
  app.use(cookieParser());

  // Global exception filter for standardized error responses
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global interceptor for standardized success responses
  app.useGlobalInterceptors(new ResponseInterceptor());

  // Enable validation globally
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Remove unknown properties
      forbidNonWhitelisted: true, // Throw error for unknown properties
      transform: true, // Transform payloads to DTO instances
      transformOptions: {
        enableImplicitConversion: true, // Automatically convert types (e.g., string "3" to number 3)
      },
    }),
  );

  // Enable CORS with credentials support for cookie-based auth
  const isProduction = process.env.IS_PRODUCTION === 'true';
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const isLocalDevOrigin = (origin: string) =>
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(
      origin,
    );

  console.log('CORS Configuration:');
  console.log('- IS_PRODUCTION:', isProduction);
  console.log('- Allowed Origins:', allowedOrigins);

  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, Postman, curl)
      if (!origin) {
        return callback(null, true);
      }

      // Check if origin is in allowed list
      const isAllowed =
        allowedOrigins.includes(origin) ||
        (!isProduction && isLocalDevOrigin(origin));

      if (isAllowed) {
        return callback(null, true);
      }
      console.warn(`CORS blocked - Origin: ${origin}`);
      callback(null, false);
    },
    // origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Accept',
      'Origin',
    ],
    optionsSuccessStatus: 204,
  });

  // Set global prefix for all routes
  app.setGlobalPrefix('api');

  const swaggerUiPath = 'docs-v2';

  app.use((req, res, next) => {
    if (req.path === '/docs' || req.path === '/docs/') {
      res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, proxy-revalidate',
      );
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');
      res.redirect(302, `/${swaggerUiPath}`);
      return;
    }

    if (
      req.path === `/${swaggerUiPath}` ||
      req.path === '/docs-json' ||
      req.path === '/docs-yaml' ||
      req.path.startsWith(`/${swaggerUiPath}/`)
    ) {
      res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, proxy-revalidate',
      );
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');
    }

    next();
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Storefront API')
    .setDescription('API documentation for the storefront backend.')
    .setVersion(process.env.APP_VERSION ?? '0.0.1')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT access token for bearer-protected endpoints.',
      },
      'bearer',
    )
    .addCookieAuth(
      'access_token',
      {
        type: 'apiKey',
        in: 'cookie',
        description: 'HTTP-only access token cookie set by auth endpoints.',
      },
      'cookieAuth',
    )
    .build();

  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig, {
    deepScanRoutes: true,
  });

  SwaggerModule.setup(swaggerUiPath, app, swaggerDocument, {
    customSiteTitle: 'Storefront API Docs',
    jsonDocumentUrl: 'docs-json',
    yamlDocumentUrl: 'docs-yaml',
    swaggerUrl: '/docs-json',
    swaggerOptions: {
      persistAuthorization: true,
      withCredentials: true,
    },
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);

  const appUrl = await app.getUrl();
  console.log(`Application is running on: ${appUrl}/api`);
  console.log(`Swagger UI is available at: ${appUrl}/${swaggerUiPath}`);
  console.log(`Legacy Swagger URL redirects from: ${appUrl}/docs`);
  console.log(`OpenAPI JSON is available at: ${appUrl}/docs-json`);
  console.log(`OpenAPI YAML is available at: ${appUrl}/docs-yaml`);
}
bootstrap();
