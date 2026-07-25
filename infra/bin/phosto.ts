#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { PhostoStack, type PhostoConfig } from '../lib/phosto-stack';

const configPath = resolve(__dirname, '..', 'config.json');

if (!existsSync(configPath)) {
  throw new Error(
    'infra/config.json not found. Copy infra/config.example.json to infra/config.json and fill it in.',
  );
}

const config = JSON.parse(readFileSync(configPath, 'utf8')) as PhostoConfig;

const publicKeyPath = resolve(__dirname, '..', config.signingPublicKeyPath);
if (!existsSync(publicKeyPath)) {
  throw new Error(
    `CloudFront public key not found at ${publicKeyPath}. Run \`npm run bootstrap:keys\` first.`,
  );
}

const app = new cdk.App();

new PhostoStack(app, 'PhostoStack', {
  env: { account: config.account, region: config.region },
  description: 'phosto — photo gallery with folder sharing and hidden RAWs',
  config,
  signingPublicKeyPem: readFileSync(publicKeyPath, 'utf8'),
});

app.synth();
