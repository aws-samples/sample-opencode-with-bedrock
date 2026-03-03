/**
 * Unit tests for the Share Lambda API.
 *
 * These tests run with the root Jest config (jest.config.js) via `npm test`.
 * AWS SDK calls are mocked — no real S3/Lambda calls are made.
 */

// ---------------------------------------------------------------------------
// Mock Storage before importing Share (which imports Storage at module scope)
// ---------------------------------------------------------------------------
const mockStorage: Record<string, any> = {};

jest.mock('../services/share/lambda/src/storage.js', () => ({
  Storage: {
    read: jest.fn(async (key: string[]) => {
      const path = key.join('/');
      return mockStorage[path];
    }),
    write: jest.fn(async (key: string[], value: any) => {
      const path = key.join('/');
      mockStorage[path] = value;
    }),
    remove: jest.fn(async (key: string[]) => {
      const path = key.join('/');
      delete mockStorage[path];
    }),
    list: jest.fn(async () => []),
  },
}));

// Mock @aws-sdk/client-lambda for broadcastUpdate
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({}),
  })),
  InvokeCommand: jest.fn(),
}));

// Suppress console.log/error during tests
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// Clear mock storage between tests
beforeEach(() => {
  for (const key of Object.keys(mockStorage)) {
    delete mockStorage[key];
  }
  jest.clearAllMocks();
});

// Set required env vars
process.env.OPENCODE_STORAGE_BUCKET = 'test-bucket';
process.env.OPENCODE_STORAGE_REGION = 'us-east-1';
process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------------
// Import modules under test AFTER mocks are wired up
// ---------------------------------------------------------------------------
import { Share } from '../services/share/lambda/src/share.js';
import {
  healthHandler,
  createShareHandler,
  syncShareHandler,
  getShareDataHandler,
  deleteShareHandler,
  viewShareHandler,
  landingPageHandler,
} from '../services/share/lambda/src/handlers.js';
import { handler } from '../services/share/lambda/src/index.js';

// ===================================================================
// Share business logic tests
// ===================================================================
describe('Share.create', () => {
  test('creates a new share and stores it', async () => {
    const info = await Share.create({ sessionID: 'test_session_abc12345' });
    expect(info.id).toBeDefined();
    expect(info.secret).toBeDefined();
    expect(info.sessionID).toBe('test_session_abc12345');
  });

  test('returns existing share if same sessionID', async () => {
    const info1 = await Share.create({ sessionID: 'test_session_abc12345' });
    const info2 = await Share.create({ sessionID: 'test_session_abc12345' });
    expect(info2.id).toBe(info1.id);
    expect(info2.secret).toBe(info1.secret);
  });

  test('throws AlreadyExists if different sessionID collides on share id', async () => {
    // Create with one session. Share ID is derived from last 8 chars: "Xbc12345" -> id "test_Xbc12345"
    await Share.create({ sessionID: 'test_session_Xbc12345' });
    // Manually insert a different sessionID at the same share key to simulate collision
    const { Storage } = require('../services/share/lambda/src/storage.js');
    const existingShare = await Share.get('test_Xbc12345');
    // Overwrite the stored share with a different sessionID
    (Storage.read as jest.Mock).mockImplementationOnce(async (key: string[]) => {
      if (key.join('/') === `share/test_Xbc12345`) {
        return { ...existingShare, sessionID: 'different_session_id' };
      }
      return mockStorage[key.join('/')];
    });
    await expect(
      Share.create({ sessionID: 'test_session_Xbc12345' })
    ).rejects.toThrow(Share.Errors.AlreadyExists);
  });
});

describe('Share.sync', () => {
  test('stores sync data for a valid share', async () => {
    const info = await Share.create({ sessionID: 'test_session_sync0001' });
    await Share.sync({
      share: { id: info.id, secret: info.secret },
      data: [
        { type: 'session', data: { id: 's1', title: 'Test' } },
      ],
    });
    // Should not throw
  });

  test('throws NotFound for non-existent share', async () => {
    await expect(
      Share.sync({
        share: { id: 'nonexistent', secret: 'bad' },
        data: [],
      })
    ).rejects.toThrow(Share.Errors.NotFound);
  });

  test('throws InvalidSecret for wrong secret', async () => {
    const info = await Share.create({ sessionID: 'test_session_sync0002' });
    await expect(
      Share.sync({
        share: { id: info.id, secret: 'wrong-secret-value-here' },
        data: [],
      })
    ).rejects.toThrow(Share.Errors.InvalidSecret);
  });

  test('throws PayloadTooLarge for too many items', async () => {
    const info = await Share.create({ sessionID: 'test_session_sync0003' });
    const tooManyItems = Array.from({ length: 501 }, (_, i) => ({
      type: 'message' as const,
      data: { id: `msg-${i}`, role: 'user' as const },
    }));
    await expect(
      Share.sync({
        share: { id: info.id, secret: info.secret },
        data: tooManyItems,
      })
    ).rejects.toThrow(Share.Errors.PayloadTooLarge);
  });
});

describe('Share.remove', () => {
  test('removes a share with correct secret', async () => {
    const info = await Share.create({ sessionID: 'test_session_rm000001' });
    await Share.remove({ id: info.id, secret: info.secret });
    const result = await Share.get(info.id);
    expect(result).toBeUndefined();
  });

  test('throws NotFound for non-existent share', async () => {
    await expect(
      Share.remove({ id: 'nonexistent', secret: 'bad' })
    ).rejects.toThrow(Share.Errors.NotFound);
  });

  test('throws InvalidSecret for wrong secret', async () => {
    const info = await Share.create({ sessionID: 'test_session_rm000002' });
    await expect(
      Share.remove({ id: info.id, secret: 'wrong-secret-value-here' })
    ).rejects.toThrow(Share.Errors.InvalidSecret);
  });
});

describe('Share.Data schema validation', () => {
  test('validates session data', () => {
    const result = Share.Data.safeParse({
      type: 'session',
      data: { id: 's1', title: 'Test', version: '1.0.0' },
    });
    expect(result.success).toBe(true);
  });

  test('validates message data', () => {
    const result = Share.Data.safeParse({
      type: 'message',
      data: { id: 'm1', role: 'user' },
    });
    expect(result.success).toBe(true);
  });

  test('validates part data', () => {
    const result = Share.Data.safeParse({
      type: 'part',
      data: { id: 'p1', messageID: 'm1', type: 'text', text: 'hello' },
    });
    expect(result.success).toBe(true);
  });

  test('rejects invalid message role', () => {
    const result = Share.Data.safeParse({
      type: 'message',
      data: { id: 'm1', role: 'invalid_role' },
    });
    expect(result.success).toBe(false);
  });

  test('rejects unknown type', () => {
    const result = Share.Data.safeParse({
      type: 'unknown_type',
      data: {},
    });
    expect(result.success).toBe(false);
  });
});

// ===================================================================
// Handler tests
// Cast results to `any` because APIGatewayProxyResultV2 is a union
// type (APIGatewayProxyStructuredResultV2 | string) — our handlers
// always return the structured form.
// ===================================================================
describe('healthHandler', () => {
  test('returns 200 with status ok', async () => {
    const result: any = await healthHandler();
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.status).toBe('ok');
    expect(body.service).toBe('opencode-share-api');
  });
});

describe('createShareHandler', () => {
  test('returns 400 if sessionID is missing', async () => {
    const event = { body: JSON.stringify({}), headers: {} } as any;
    const result: any = await createShareHandler(event);
    expect(result.statusCode).toBe(400);
  });

  test('returns 200 with share info on success', async () => {
    process.env.SHARE_VIEWER_BASE_URL = 'https://share.example.com';
    const event = {
      body: JSON.stringify({ sessionID: 'test_session_hnd00001' }),
      headers: {},
    } as any;
    const result: any = await createShareHandler(event);
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.id).toBeDefined();
    expect(body.secret).toBeDefined();
    expect(body.url).toContain('https://share.example.com/share/');
  });
});

describe('syncShareHandler', () => {
  test('returns 400 if shareID is missing', async () => {
    const event = { pathParameters: {}, body: '{}', headers: {} } as any;
    const result: any = await syncShareHandler(event);
    expect(result.statusCode).toBe(400);
  });

  test('returns 400 if secret is missing', async () => {
    const event = {
      pathParameters: { shareID: 'abc' },
      body: JSON.stringify({ data: [] }),
      headers: {},
    } as any;
    const result: any = await syncShareHandler(event);
    expect(result.statusCode).toBe(400);
  });

  test('returns 400 if data is not an array', async () => {
    const event = {
      pathParameters: { shareID: 'abc' },
      body: JSON.stringify({ secret: 'x', data: 'not-array' }),
      headers: {},
    } as any;
    const result: any = await syncShareHandler(event);
    expect(result.statusCode).toBe(400);
  });

  test('returns 404 for non-existent share', async () => {
    const event = {
      pathParameters: { shareID: 'nonexistent' },
      body: JSON.stringify({ secret: 'bad', data: [] }),
      headers: {},
    } as any;
    const result: any = await syncShareHandler(event);
    expect(result.statusCode).toBe(404);
  });
});

describe('deleteShareHandler', () => {
  test('returns 400 if shareID is missing', async () => {
    const event = { pathParameters: {}, body: '{}', headers: {} } as any;
    const result: any = await deleteShareHandler(event);
    expect(result.statusCode).toBe(400);
  });

  test('returns 400 if secret is missing', async () => {
    const event = {
      pathParameters: { shareID: 'abc' },
      body: JSON.stringify({}),
      headers: {},
    } as any;
    const result: any = await deleteShareHandler(event);
    expect(result.statusCode).toBe(400);
  });

  test('returns 404 for non-existent share', async () => {
    const event = {
      pathParameters: { shareID: 'nonexistent' },
      body: JSON.stringify({ secret: 'bad' }),
      headers: {},
    } as any;
    const result: any = await deleteShareHandler(event);
    expect(result.statusCode).toBe(404);
  });
});

describe('getShareDataHandler', () => {
  test('returns 400 if shareID is missing', async () => {
    const event = { pathParameters: {}, headers: {} } as any;
    const result: any = await getShareDataHandler(event);
    expect(result.statusCode).toBe(400);
  });
});

describe('viewShareHandler', () => {
  test('returns 400 if shareID is missing', async () => {
    const event = { pathParameters: {}, headers: {} } as any;
    const result: any = await viewShareHandler(event);
    expect(result.statusCode).toBe(400);
  });

  test('returns 404 for non-existent share', async () => {
    const event = { pathParameters: { shareID: 'nonexistent' }, headers: {} } as any;
    const result: any = await viewShareHandler(event);
    expect(result.statusCode).toBe(404);
  });

  test('returns HTML with CSP headers for existing share', async () => {
    const info = await Share.create({ sessionID: 'test_session_view0001' });
    const event = { pathParameters: { shareID: info.id }, headers: {} } as any;
    const result: any = await viewShareHandler(event);
    expect(result.statusCode).toBe(200);
    expect((result.headers as any)['Content-Type']).toBe('text/html');
    expect((result.headers as any)['Content-Security-Policy']).toBeDefined();
    expect((result.headers as any)['X-Frame-Options']).toBe('DENY');
    expect(result.body).toContain('<!DOCTYPE html>');
  });
});

describe('landingPageHandler', () => {
  test('returns 200 with HTML landing page', async () => {
    const result: any = await landingPageHandler();
    expect(result.statusCode).toBe(200);
    expect((result.headers as any)['Content-Type']).toBe('text/html');
    expect(result.body).toContain('OpenCode Share');
  });
});

// ===================================================================
// Router (index.ts handler) tests
// ===================================================================
describe('handler routing', () => {
  test('routes GET /health to healthHandler', async () => {
    const event = { rawPath: '/health', requestContext: { http: { method: 'GET' } } };
    const result: any = await handler(event);
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.status).toBe('ok');
  });

  test('routes GET / to landingPageHandler', async () => {
    const event = { rawPath: '/', requestContext: { http: { method: 'GET' } } };
    const result: any = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain('OpenCode Share');
  });

  test('strips stage prefix from path', async () => {
    const event = { rawPath: '/prod/health', requestContext: { http: { method: 'GET' } } };
    const result: any = await handler(event);
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.status).toBe('ok');
  });

  test('handles OPTIONS for CORS', async () => {
    const event = { rawPath: '/api/share', requestContext: { http: { method: 'OPTIONS' } } };
    const result: any = await handler(event);
    expect(result.statusCode).toBe(200);
    expect((result.headers as any)['Access-Control-Allow-Methods']).toContain('POST');
  });

  test('returns 404 for unmatched routes', async () => {
    const event = { rawPath: '/unknown', requestContext: { http: { method: 'GET' } } };
    const result: any = await handler(event);
    expect(result.statusCode).toBe(404);
  });

  test('extracts pathParameters from ALB-style path', async () => {
    const createEvent = {
      rawPath: '/api/share',
      requestContext: { http: { method: 'POST' } },
      body: JSON.stringify({ sessionID: 'test_session_route001' }),
      headers: {},
    };
    const createResult: any = await handler(createEvent);
    expect(createResult.statusCode).toBe(200);

    const shareInfo = JSON.parse(createResult.body as string);

    const dataEvent = {
      rawPath: `/api/share/${shareInfo.id}/data`,
      requestContext: { http: { method: 'GET' } },
      headers: {},
    };
    const dataResult: any = await handler(dataEvent);
    expect(dataResult.statusCode).toBe(200);
  });
});
