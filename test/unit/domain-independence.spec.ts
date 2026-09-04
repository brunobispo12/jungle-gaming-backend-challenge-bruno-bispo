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

function domainSources(): Array<{ name: string; source: string }> {
  return readdirSync(DOMAIN_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, source: readFileSync(path.join(DOMAIN_DIR, name), 'utf8') }));
}

describe('domínio independente de framework', () => {
  test('nenhum arquivo importa ORM, NestJS, AWS SDK ou HTTP', () => {
    const sources = domainSources();
    expect(sources.length).toBeGreaterThan(0);

    const offenders = sources.flatMap(({ name, source }) =>
      FORBIDDEN.filter((dependency) => source.includes(`'${dependency}`)).map(
        (dependency) => `${name} -> ${dependency}`,
      ),
    );

    expect(offenders).toEqual([]);
  });

  test('nenhum arquivo usa decorator de framework', () => {
    const sources = domainSources();
    expect(sources.length).toBeGreaterThan(0);

    const offenders = sources
      .filter(({ source }) => /^\s*@[A-Z]\w*\s*\(/m.test(source))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });
});
