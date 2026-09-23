import { redactKnownSecrets, redactUrl, redactValue } from '../../src/core/redaction.js';

describe('evidence redaction', () => {
  it('redacts secret fields and bearer tokens', () => {
    expect(redactValue({ authorization: 'Bearer abc', nested: { apiKey: 'secret' } })).toEqual({
      authorization: '[REDACTED]',
      nested: { apiKey: '[REDACTED]' },
    });
    expect(redactValue('Bearer abc.def')).toBe('Bearer [REDACTED]');
  });

  it('redacts sensitive URL query values', () => {
    expect(redactUrl('https://example.com/?token=secret&sku=abc')).toContain('token=%5BREDACTED%5D');
    expect(redactUrl('https://example.com/?token=secret&sku=abc')).toContain('sku=abc');
  });

  it('scrubs JWT paths in URL fields as well as credentials and query secrets', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature';
    const value = `https://user:pass@example.com/verify/${jwt}?token=private&sku=abc`;
    const result = redactValue({ url: value, sourceURL: value });
    const text = JSON.stringify(result);
    expect(text).not.toContain(jwt);
    expect(text).not.toContain('user:pass');
    expect(text).not.toContain('private');
    expect(text).toContain('[REDACTED_JWT]');
    expect(text).toContain('sku=abc');
    expect(redactValue({ url: 'Bearer abc.def' })).toEqual({ url: 'Bearer [REDACTED]' });
  });

  describe('redactKnownSecrets', () => {
    it('scrubs every occurrence of a known secret value, wherever it appears in the text', () => {
      expect(redactKnownSecrets('status: header-authorized:shh, retry with shh', ['shh'])).toBe(
        'status: header-authorized:[REDACTED], retry with [REDACTED]',
      );
    });

    it('scrubs against multiple configured secrets', () => {
      expect(redactKnownSecrets('a=one b=two', ['one', 'two'])).toBe('a=[REDACTED] b=[REDACTED]');
    });

    it('leaves the text unchanged when no secret is configured', () => {
      expect(redactKnownSecrets('nothing to see here', [undefined])).toBe('nothing to see here');
      expect(redactKnownSecrets('nothing to see here', [])).toBe('nothing to see here');
    });

    it('also scrubs the HTML-entity-encoded form of a secret, so an escaping page cannot defeat the exact match', () => {
      const secret = 'p&ss<word>"quote\'';
      const escaped = 'p&amp;ss&lt;word&gt;&quot;quote&#39;';
      expect(redactKnownSecrets(`raw: ${secret}, escaped: ${escaped}`, [secret])).toBe(
        'raw: [REDACTED], escaped: [REDACTED]',
      );
    });
  });
});
