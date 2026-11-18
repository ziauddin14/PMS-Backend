import { describe, expect, it } from 'vitest';
import { cleanText, masterNameSchema, purchaseOrderCreateSchema } from '../../src/contracts/api.js';
import { paymentCreateSchema } from '../../src/contracts/operations.js';

describe('free-text cleaning (no "invalid characters" errors)', () => {
  it('keeps line breaks in multi-line text and normalises Windows line breaks', () => {
    expect(cleanText('  1234 Synthetic tax 5.5%\r\n5678 Synthetic payment  ', true)).toBe(
      '1234 Synthetic tax 5.5%\n5678 Synthetic payment',
    );
  });

  it('turns line breaks into spaces in single-line text and drops invisible characters', () => {
    expect(cleanText('Synthetic\r\nName\u0007')).toBe('Synthetic Name');
  });

  it('accepts any visible characters, including Urdu, symbols and emoji', () => {
    const text = 'نوٹ — #1 @ Rs. 5,000/- (50%) & "quoted" <ok> 👍';
    expect(cleanText(text, true)).toBe(text);
  });

  it('accepts multi-line payment notes', () => {
    const parsed = paymentCreateSchema.safeParse({
      purchaseOrderId: 'a'.repeat(24),
      paymentDate: '2026-01-05',
      amount: 100,
      method: 'BANK_TRANSFER',
      notes: '111 Synthetic income tax 5.5 percent\r\n222 Synthetic vendor payment',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.notes).toBe(
      '111 Synthetic income tax 5.5 percent\n222 Synthetic vendor payment',
    );
  });

  it('cleans names and PO numbers instead of rejecting them', () => {
    expect(masterNameSchema.parse(' Synthetic\tItem ')).toBe('Synthetic Item');
    expect(masterNameSchema.safeParse('\u0007 ').success).toBe(false);
    const po = purchaseOrderCreateSchema.safeParse({
      poNumber: 'PO\n1',
      poDate: '2026-01-05',
      vendorId: 'a'.repeat(24),
      deliveryRoute: 'WAREHOUSE',
      targetWarehouseId: 'b'.repeat(24),
      approvedAmount: 0,
      notes: 'line one\nline two',
      lines: [{ itemId: 'c'.repeat(24), quantityOrdered: 1, unitPrice: 1 }],
    });
    expect(po.success).toBe(true);
    expect(po.data?.poNumber).toBe('PO 1');
    expect(po.data?.notes).toBe('line one\nline two');
  });
});
