import { describe, expect, test } from 'bun:test';

import { CurrencyMismatchError, InvalidMoneyError } from '@/domain/domain-error';
import { Money } from '@/domain/money';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

describe('Money — entradas inválidas', () => {
  test.each([
    ['TST-001 NaN', 'NaN'],
    ['TST-002 Infinity', 'Infinity'],
    ['TST-002 -Infinity', '-Infinity'],
    ['TST-003 notação científica', '1e2'],
    ['TST-003 notação científica negativa', '1E-2'],
    ['TST-004 string vazia', ''],
    ['TST-005 mais de 2 casas', '25.001'],
    ['espaços em volta', ' 25.00 '],
    ['separador de milhar', '1,000.00'],
    ['sinal positivo explícito', '+25.00'],
    ['ponto sem dígitos', '25.'],
    ['apenas ponto', '.'],
  ])('%s é rejeitado', (_label, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('TST-056 mais de 2 casas é rejeitado, nunca arredondado', () => {
    expect(() => brl('25.005')).toThrow(InvalidMoneyError);
    expect(() => brl('25.999')).toThrow(InvalidMoneyError);
  });

  test('TST-006 valor negativo é rejeitado no contrato de entrada', () => {
    expect(() => brl('-25.00')).toThrow(InvalidMoneyError);
    expect(() => brl('-0.01')).toThrow(InvalidMoneyError);
  });

  test('TST-006 negate produz instância válida com valor negativo', () => {
    const negative = brl('25.00').negate();

    expect(negative.isNegative()).toBe(true);
    expect(negative.toString()).toBe('-25.00');
  });

  test('valor acima do teto de numeric(20,2) é rejeitado', () => {
    expect(() => brl('999999999999999999.99')).not.toThrow();
    expect(() => brl('1000000000000000000.00')).toThrow(InvalidMoneyError);
  });

  test.each([['brl'], ['BRLL'], ['BR'], ['123'], ['']])('currency %p é rejeitada', (currency) => {
    expect(() => Money.from({ amount: '25.00', currency })).toThrow(InvalidMoneyError);
  });
});

describe('Money — escala e serialização', () => {
  test('TST-007 serializa sempre com escala 2', () => {
    expect(brl('25.50').toString()).toBe('25.50');
    expect(Money.zero('BRL').toString()).toBe('0.00');
    expect(brl('25.50').toJSON()).toEqual({ amount: '25.50', currency: 'BRL' });
    expect(Money.zero('BRL').toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  test('TST-057 escala menor que 2 é normalizada sem alterar o valor', () => {
    expect(brl('25').toString()).toBe('25.00');
    expect(brl('25.5').toString()).toBe('25.50');
    expect(brl('0').toString()).toBe('0.00');
  });

  test('zeros à esquerda não mudam a representação canônica', () => {
    expect(brl('025.00').toString()).toBe('25.00');
    expect(brl('025.00').equals(brl('25.00'))).toBe(true);
  });

  test('zero nunca é serializado com sinal, por nenhum caminho', () => {
    const paths = [
      brl('-0.00'),
      brl('-0'),
      Money.zero('BRL').negate(),
      brl('10.00').subtract(brl('10.00')),
      brl('10.00').subtract(brl('10.00')).negate(),
    ];

    for (const money of paths) {
      expect(money.toString()).toBe('0.00');
      expect(money.isNegative()).toBe(false);
      expect(money.isZero()).toBe(true);
      expect(money.equals(Money.zero('BRL'))).toBe(true);
    }
  });
});

describe('Money — aritmética exata', () => {
  test('TST-009 soma sem erro de ponto flutuante', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
  });

  test('TST-009 subtração sem erro de ponto flutuante', () => {
    expect(brl('0.30').subtract(brl('0.10')).toString()).toBe('0.20');
  });

  test('soma de muitos centavos não acumula erro', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 1000; i += 1) {
      total = total.add(brl('0.01'));
    }
    expect(total.toString()).toBe('10.00');
  });

  test('TST-008 add e subtract devolvem nova instância e não mutam os operandos', () => {
    const a = brl('10.00');
    const b = brl('3.00');

    const sum = a.add(b);
    const difference = a.subtract(b);

    expect(sum).not.toBe(a);
    expect(difference).not.toBe(a);
    expect(a.toString()).toBe('10.00');
    expect(b.toString()).toBe('3.00');
    expect(sum.toString()).toBe('13.00');
    expect(difference.toString()).toBe('7.00');
  });

  test('subtração pode produzir negativo, como a diferença de reconciliação', () => {
    expect(brl('10.00').subtract(brl('30.00')).toString()).toBe('-20.00');
  });
});

describe('Money — faixa interna de numeric(20,2)', () => {
  const MAX = '999999999999999999.99';

  test('os extremos positivo e negativo são representáveis', () => {
    expect(brl(MAX).toString()).toBe(MAX);
    expect(brl(MAX).negate().toString()).toBe(`-${MAX}`);
  });

  test('overflow na soma falha de forma determinística', () => {
    expect(() => brl(MAX).add(brl('0.01'))).toThrow(InvalidMoneyError);
    expect(() => brl(MAX).add(brl(MAX))).toThrow(InvalidMoneyError);
  });

  test('underflow na subtração falha de forma determinística', () => {
    expect(() => brl(MAX).negate().subtract(brl('0.01'))).toThrow(InvalidMoneyError);
    expect(() => Money.zero('BRL').subtract(brl(MAX)).subtract(brl('0.01'))).toThrow(
      InvalidMoneyError,
    );
  });

  test('a aritmética interna nunca ganha uma terceira casa decimal', () => {
    const values = [brl('0.01'), brl('0.10'), brl(MAX), Money.zero('BRL')];

    for (const a of values) {
      for (const b of values) {
        for (const result of [() => a.add(b), () => a.subtract(b)]) {
          try {
            expect(result().toString()).toMatch(/^-?\d+\.\d{2}$/);
          } catch (error) {
            expect(error).toBeInstanceOf(InvalidMoneyError);
          }
        }
      }
    }
  });
});

describe('Money — moeda', () => {
  test('TST-010 aritmética entre moedas diferentes lança erro de domínio', () => {
    const real = brl('10.00');
    const dollar = Money.from({ amount: '10.00', currency: 'USD' });

    expect(() => real.add(dollar)).toThrow(CurrencyMismatchError);
    expect(() => real.subtract(dollar)).toThrow(CurrencyMismatchError);
  });

  test('TST-011 comparação entre moedas diferentes lança erro de domínio', () => {
    const real = brl('10.00');
    const dollar = Money.from({ amount: '10.00', currency: 'USD' });

    expect(() => real.isLessThan(dollar)).toThrow(CurrencyMismatchError);
    expect(() => real.equals(dollar)).toThrow(CurrencyMismatchError);
  });

  test('predicados de sinal não dependem de comparação entre moedas', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').negate().isNegative()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
    expect(Money.zero('BRL').isNegative()).toBe(false);
  });
});
