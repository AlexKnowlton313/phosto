import { join, resolve } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

const repoRoot = resolve(__dirname, '..', '..');

export interface PhostoConfig {
  account: string;
  region: string;
  domainName: string;
  hostedZoneName: string;
  bucketName: string;
  signingKeyParameterName: string;
  signingPublicKeyPath: string;
  /**
   * Where alarms go. Optional, and the alarms only exist when it is set — an SNS
   * email subscription has to be confirmed from the inbox, so there is no
   * sensible default and a half-wired topic is worse than none.
   */
  alarmEmail?: string;
}

export interface PhostoStackProps extends cdk.StackProps {
  config: PhostoConfig;
  signingPublicKeyPem: string;
}

/**
 * Key prefixes. No folder id appears in any of them — a photo can be in several
 * rolls at once, so nothing about its key can name one:
 *
 *   f/<photoId>/*   derivatives, admin by cookie, shares by per-object signed URL
 *   orig/<photoId>  full-size originals, one signed URL per download
 *   raw/<photoId>   RAW files, one signed URL per download, → Glacier IR
 *
 * The split between the three is still load-bearing, for two reasons. The derive
 * Lambda listens on `orig/` and `raw/` and writes to `f/`, so sharing a prefix
 * between input and output would make every write retrigger the function. And the
 * admin's cookie covers `f/*` only, so it structurally cannot reach an original or
 * a RAW however the API behaves — those need a URL minted per object.
 */
const PREFIX = { derived: 'f/', originals: 'orig/', raw: 'raw/' } as const;

/** Literal so the API function can read it without depending on the distribution. */
const DISTRIBUTION_ID_PARAM = '/phosto/distribution-id';

export class PhostoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PhostoStackProps) {
    super(scope, id, props);
    const { config } = props;

    // ---------------------------------------------------------------- storage

    const bucket = new s3.Bucket(this, 'PhotoBucket', {
      bucketName: config.bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // A photo library is not something to lose to `cdk destroy`.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: [`https://${config.domainName}`, 'http://localhost:5173'],
          allowedHeaders: ['*'],
          // Browser multipart uploads need to read the ETag off each part.
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        {
          id: 'raw-to-glacier-instant-retrieval',
          prefix: PREFIX.raw,
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
        {
          // A 30MB RAF upload that dies halfway leaves parts that are billed as
          // storage but invisible in the console. Sweep them.
          id: 'abort-incomplete-multipart',
          enabled: true,
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });

    const table = new dynamodb.Table(this, 'PhotoTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Expired share tokens delete themselves.
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    table.addGlobalSecondaryIndex({
      indexName: 'gsi1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
    });

    // ------------------------------------------------------------------- auth

    const userPool = new cognito.UserPool(this, 'AdminPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const userPoolClient = userPool.addClient('WebClient', {
      authFlows: { userSrp: true },
      accessTokenValidity: cdk.Duration.hours(8),
      idTokenValidity: cdk.Duration.hours(8),
      refreshTokenValidity: cdk.Duration.days(30),
      preventUserExistenceErrors: true,
    });

    // -------------------------------------------------- cloudfront signing key

    const publicKey = new cloudfront.PublicKey(this, 'SigningPublicKey', {
      encodedKey: props.signingPublicKeyPem,
      comment: 'phosto — signs share cookies and download URLs',
    });

    const keyGroup = new cloudfront.KeyGroup(this, 'SigningKeyGroup', {
      items: [publicKey],
    });

    const privateKeyParamArn = cdk.Arn.format(
      {
        service: 'ssm',
        resource: 'parameter',
        resourceName: config.signingKeyParameterName.replace(/^\//, ''),
      },
      this,
    );

    // ------------------------------------------------------------------ lambda

    const sharpLayer = new lambda.LayerVersion(this, 'ImageLayer', {
      code: lambda.Code.fromAsset(join(repoRoot, 'functions/layers/sharp')),
      compatibleRuntimes: [lambda.Runtime.NODEJS_24_X],
      compatibleArchitectures: [lambda.Architecture.ARM_64],
      description: 'sharp + libheif-js built for linux-arm64',
    });

    // The prefixes are not passed: `functions/shared/keys.ts` holds the same three
    // literals, because changing one would orphan every object already under it.
    const commonEnv = {
      TABLE_NAME: table.tableName,
      BUCKET_NAME: bucket.bucketName,
      DOMAIN_NAME: config.domainName,
      NODE_OPTIONS: '--enable-source-maps',
    };

    const bundling = {
      minify: true,
      sourceMap: true,
      target: 'node24',
      format: cdk.aws_lambda_nodejs.OutputFormat.ESM,
      // The AWS SDK ships CommonJS that calls require() internally. An ESM bundle
      // has no require, so without this shim the function dies at init with
      // 'Dynamic require of "node:https" is not supported' — before any handler
      // code runs, which makes it look like a permissions or trigger problem
      // rather than a bundling one.
      banner:
        "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
    };

    const apiFn = new NodejsFunction(this, 'ApiFunction', {
      entry: join(repoRoot, 'functions/api/index.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      // 1769 MB is exactly one vCPU — below it Lambda hands out a fraction, and
      // opening a share is now CPU-bound: it signs a URL per derivative per photo,
      // which is ~400 RSA operations for a 200-frame roll. At 512 MB that was
      // ~1.6s of signing; here it is ~540ms. Roughly cost-neutral, since duration
      // falls about as fast as the per-ms price rises, and it stays inside the
      // 400k GB-s permanent free tier either way.
      memorySize: 1769,
      timeout: cdk.Duration.seconds(15),
      bundling,
      environment: {
        ...commonEnv,
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
        KEY_PAIR_ID: publicKey.publicKeyId,
        PRIVATE_KEY_PARAM: config.signingKeyParameterName,
      },
    });

    const deriveFn = new NodejsFunction(this, 'DeriveFunction', {
      entry: join(repoRoot, 'functions/derive/index.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      // Decoding a 26MP frame and writing three sizes wants headroom; more memory
      // also means more CPU, so this is usually cheaper per-photo, not dearer.
      memorySize: 2048,
      timeout: cdk.Duration.minutes(2),
      layers: [sharpLayer],
      bundling: { ...bundling, externalModules: ['sharp', 'libheif-js'] },
      environment: commonEnv,
    });

    table.grantReadWriteData(apiFn);
    table.grantReadWriteData(deriveFn);
    bucket.grantReadWrite(apiFn);
    bucket.grantReadWrite(deriveFn);

    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [privateKeyParamArn],
      }),
    );

    // No cognito-idp grant on purpose: aws-jwt-verify checks the access token
    // against the pool's public JWKS offline, so the API never calls Cognito.

    bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(deriveFn),
      { prefix: PREFIX.originals },
    );

    bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(deriveFn),
      { prefix: PREFIX.raw },
    );

    // --------------------------------------------------------------------- api

    const httpApi = new cdk.aws_apigatewayv2.HttpApi(this, 'HttpApi', {
      apiName: 'phosto',
      // CloudFront is the only intended front door, but keep CORS permissive
      // enough for `vite dev` against the deployed API.
      corsPreflight: {
        allowOrigins: [`https://${config.domainName}`, 'http://localhost:5173'],
        allowMethods: [cdk.aws_apigatewayv2.CorsHttpMethod.ANY],
        allowHeaders: ['authorization', 'content-type'],
        allowCredentials: true,
      },
    });

    const apiIntegration =
      new cdk.aws_apigatewayv2_integrations.HttpLambdaIntegration(
        'ApiIntegration',
        apiFn,
      );

    httpApi.addRoutes({
      path: '/api/{proxy+}',
      methods: [cdk.aws_apigatewayv2.HttpMethod.ANY],
      integration: apiIntegration,
    });

    // The share page is rendered by the same Lambda so its HTML can carry
    // per-folder OG tags. Public by design — it is the share link itself.
    //
    // HEAD is listed explicitly: an HTTP API does *not* answer HEAD from a GET
    // route, it 404s with its own `{"message":"Not Found"}` before the
    // integration runs. Link unfurlers probe the OG image with HEAD first, so a
    // GET-only route unfurls the title and silently drops the picture.
    httpApi.addRoutes({
      path: '/s/{proxy+}',
      methods: [
        cdk.aws_apigatewayv2.HttpMethod.GET,
        cdk.aws_apigatewayv2.HttpMethod.HEAD,
      ],
      integration: apiIntegration,
    });

    // -------------------------------------------------------------- cloudfront

    const zone = route53.HostedZone.fromLookup(this, 'Zone', {
      domainName: config.hostedZoneName,
    });

    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: config.domainName,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(bucket);

    const signedBehavior = (): cloudfront.BehaviorOptions => ({
      origin: s3Origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      trustedKeyGroups: [keyGroup],
      compress: false, // already-compressed image bytes
    });

    const apiOriginDomain = `${httpApi.apiId}.execute-api.${this.region}.amazonaws.com`;
    const apiOrigin = new origins.HttpOrigin(apiOriginDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });

    /*
     * SPA routing, scoped to the default behavior.
     *
     * The obvious alternative — mapping 403/404 to /index.html via the
     * distribution's custom error responses — is wrong here, because those apply
     * to every behavior. An unsigned request for f/<id>/<photo>/thumb.webp would
     * come back as `200 text/html` instead of a refusal, which hands <img> tags an
     * HTML page rather than an error and hides expired share cookies behind what
     * looks like a success. A function attached to this one behavior leaves the
     * photo and API behaviors to fail honestly.
     */
    const spaRouting = new cloudfront.Function(this, 'SpaRouting', {
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  // Anything without a file extension is a client-side route (e.g. /s/<token>).
  if (!request.uri.split('/').pop().includes('.')) {
    request.uri = '/index.html';
  }
  return request;
}
      `),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'phosto — serve index.html for client-side routes',
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      domainNames: [config.domainName],
      certificate,
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      comment: 'phosto',
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy:
          cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        compress: true,
        functionAssociations: [
          {
            function: spaRouting,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        'api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy:
            cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          // Opening a share returns a signed URL per derivative — ~189 KB of
          // mostly-base64 for a 200-frame roll.
          compress: true,
        },
        /*
         * The share page and its preview image, rendered by the API Lambda so a
         * link unfurler gets the folder's own OG tags. This behavior bypasses the
         * SpaRouting function entirely, which is the point — /s/<token> must
         * reach the Lambda rather than be rewritten to the static index.html.
         *
         * No origin request policy: CACHING_OPTIMIZED forwards no cookies, so an
         * admin's signed cookies never reach this path, and the Host header stays
         * the API's own. The origin's `cache-control` caps the TTL at five
         * minutes, so a revoked share stops unfurling on its own.
         */
        's/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true,
        },
        [`${PREFIX.derived}*`]: signedBehavior(),
        [`${PREFIX.originals}*`]: signedBehavior(),
        [`${PREFIX.raw}*`]: signedBehavior(),
      },
      // No custom errorResponses on purpose — see the SpaRouting function above.
      // Distribution-wide error mapping would turn an unsigned photo request into
      // a 200 HTML page.
    });

    new route53.ARecord(this, 'AliasRecord', {
      zone,
      recordName: config.domainName.replace(`.${config.hostedZoneName}`, ''),
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(distribution),
      ),
    });

    // ------------------------------------------------------------ web deployment

    new s3deploy.BucketDeployment(this, 'WebDeployment', {
      sources: [
        s3deploy.Source.asset(join(repoRoot, 'web/dist')),
        // Resolves the pool/client tokens at deploy time, so the JS bundle stays
        // free of account-specific values and needs no rebuild to redeploy.
        s3deploy.Source.jsonData('config.json', {
          userPoolId: userPool.userPoolId,
          userPoolClientId: userPoolClient.userPoolClientId,
          domain: config.domainName,
        }),
      ],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ['/index.html', '/config.json'],
      // CRITICAL: prune defaults to true, which deletes every destination object
      // not present in the source — i.e. the entire photo library. Never enable it
      // while the site and the photos share a bucket.
      prune: false,
    });

    /*
     * Hiding a frame moves its bytes out of the share's key prefix, but a POP
     * that already cached the visible URL keeps serving it — derivatives carry
     * `immutable, max-age=1y` — and reopening the share mints a fresh cookie
     * that still covers that URL. Without an invalidation, hiding revokes
     * nothing at the edge, which is the entire point of the feature.
     *
     * The id travels through SSM rather than an environment variable because
     * the distribution is downstream of the API function: Distribution → HttpApi
     * → ApiFunction, so handing the function `distribution.distributionId` (or
     * granting on the distribution ARN) closes a CloudFormation cycle. The
     * parameter *name* is a literal, so reading it at runtime does not.
     */
    new ssm.StringParameter(this, 'DistributionIdParam', {
      parameterName: DISTRIBUTION_ID_PARAM,
      stringValue: distribution.distributionId,
    });

    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          cdk.Arn.format(
            {
              service: 'ssm',
              resource: 'parameter',
              resourceName: DISTRIBUTION_ID_PARAM.replace(/^\//, ''),
            },
            this,
          ),
        ],
      }),
    );

    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudfront:CreateInvalidation'],
        // Every distribution in the account, not `*`: the cycle argument says
        // only that this role cannot name *this* distribution's id, and an
        // account-scoped ARN pattern is built from `this.account` alone, which
        // is downstream of nothing.
        resources: [
          cdk.Arn.format(
            { service: 'cloudfront', region: '', resource: 'distribution', resourceName: '*' },
            this,
          ),
        ],
      }),
    );

    // ----------------------------------------------------------------- alarms

    // Two of the ten CloudWatch gives away free. The first is the only thing that
    // notices a frame failing to develop — there is no DLQ, Lambda retries an
    // async invoke twice and then drops it, and a photo with no derivatives is
    // otherwise indistinguishable from one still being worked on.
    if (config.alarmEmail) {
      const alarms = new sns.Topic(this, 'AlarmTopic', { displayName: 'phosto' });
      alarms.addSubscription(new subscriptions.EmailSubscription(config.alarmEmail));
      const notify = new cwActions.SnsAction(alarms);

      deriveFn
        .metricErrors({ period: cdk.Duration.minutes(5) })
        .createAlarm(this, 'DeriveErrorsAlarm', {
          threshold: 1,
          evaluationPeriods: 1,
          alarmDescription: 'A frame failed to develop',
          // No invocations is the normal state here; missing data is not a fault.
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        })
        .addAlarmAction(notify);

      // AWS/Billing is published to us-east-1 only, roughly every six hours. This
      // stack is already us-east-1-bound (CloudFront needs its certificate there),
      // so there is no cross-region alarm to arrange.
      new cloudwatch.Alarm(this, 'EstimatedChargesAlarm', {
        metric: new cloudwatch.Metric({
          namespace: 'AWS/Billing',
          metricName: 'EstimatedCharges',
          dimensionsMap: { Currency: 'USD' },
          statistic: 'Maximum',
          period: cdk.Duration.hours(6),
        }),
        // The whole gallery is ~$0.29/month, so $5 is a runaway, not a busy week.
        threshold: 5,
        evaluationPeriods: 1,
        alarmDescription: 'Monthly estimated charges above $5',
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(notify);
    }

    // ---------------------------------------------------------------- outputs

    new cdk.CfnOutput(this, 'SiteUrl', { value: `https://${config.domainName}` });
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, 'KeyPairId', { value: publicKey.publicKeyId });
    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
    });
  }
}
