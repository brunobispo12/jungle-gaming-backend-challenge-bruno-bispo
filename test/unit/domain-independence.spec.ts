import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'bun:test';

const DOMAIN_DIR = path.join(import.meta.dir, '..', '..', 'src', 'domain');

const FORBIDDEN = [
  '@nestjs/common',
  '@nestjs/core',
  '@mikro-orm/core',
  '@mikro-orm/postgresql',
  '@aws-sdk/client-sqs',
  'express',
];

function domainFiles(): string[] {
  return readdirSync(DOMAIN_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join(DOMAIN_DIR, name));
}

describe('domínio independente de framework', () => {
  test('há arquivos de domínio para inspecionar', () => {
    expect(domainFiles().length).toBeGreaterThan(0);
  });

  test('nenhum arquivo importa ORM, NestJS, AWS SDK ou HTTP', () => {
    const offenders: string[] = [];

    for (const file of domainFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const dependency of FORBIDDEN) {
        if (source.includes(`'${dependency}`)) {
          offenders.push(`${path.basename(file)} -> ${dependency}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test('nenhum arquivo usa decorator', () => {
    const offenders = domainFiles().filter((file) =>
      /^\s*@[A-Z]\w*\s*\(/m.test(readFileSync(file, 'utf8')),
    );

    expect(offenders.map((file) => path.basename(file))).toEqual([]);
  });

  test('todo agregado esconde o construtor atrás de factory', () => {
    const withClasses = domainFiles().filter((file) => {
      const source = readFileSync(file, 'utf8');
      return /^export class /m.test(source) && !file.endsWith('domain-error.ts');
    });

    const leaking = withClasses.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return /^\s{2}constructor\s*\(/m.test(source);
    });

    expect(leaking.map((file) => path.basename(file))).toEqual([]);
    expect(withClasses.length).toBeGreaterThan(0);
  });
});
