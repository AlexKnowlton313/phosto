#!/usr/bin/env node
/**
 * Generates the RSA key pair CloudFront uses to sign share cookies and download
 * URLs.
 *
 * The public key is written to infra/keys/ because CDK needs its contents at synth
 * time to create the CloudFront PublicKey resource. The private key goes straight
 * to SSM Parameter Store as a SecureString and is never written to disk — the API
 * Lambda reads it from there at runtime.
 *
 * Safe to re-run: it refuses to overwrite an existing parameter unless --force is
 * passed, since rotating the key invalidates every share link already handed out.
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const configPath = resolve(repoRoot, 'infra/config.json');

if (!existsSync(configPath)) {
  console.error('infra/config.json not found. Copy infra/config.example.json first.');
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const force = process.argv.includes('--force');
const publicKeyPath = resolve(repoRoot, 'infra', config.signingPublicKeyPath);

const aws = (args) =>
  execFileSync('aws', [...args, '--region', config.region], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

let parameterExists = false;
try {
  aws(['ssm', 'get-parameter', '--name', config.signingKeyParameterName]);
  parameterExists = true;
} catch {
  // ParameterNotFound is the expected first-run case.
}

if (parameterExists && !force) {
  console.error(
    `SSM parameter ${config.signingKeyParameterName} already exists.\n` +
      'Rotating the signing key invalidates every share link already handed out.\n' +
      'Re-run with --force if that is what you want.',
  );
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048, // CloudFront requires 2048-bit RSA
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

mkdirSync(dirname(publicKeyPath), { recursive: true });
writeFileSync(publicKeyPath, publicKey, { mode: 0o644 });

aws([
  'ssm',
  'put-parameter',
  '--name',
  config.signingKeyParameterName,
  '--type',
  'SecureString',
  '--value',
  privateKey,
  ...(force ? ['--overwrite'] : []),
]);

console.log(`Public key  → ${publicKeyPath}`);
console.log(`Private key → SSM ${config.signingKeyParameterName} (SecureString)`);
console.log('\nNext: npm run deploy');
