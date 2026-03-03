/**
 * Unit tests for the Share WebSocket Lambda handlers.
 *
 * Tests cover input validation and error handling paths that don't require
 * deep AWS SDK mocking. The handlers create DynamoDB/APIGW clients at module
 * scope, making full integration-style mocking fragile with ts-jest.
 *
 * For full end-to-end coverage of DynamoDB and WebSocket interactions,
 * use integration tests with localstack or deploy-time tests.
 */

// ---------------------------------------------------------------------------
// Mock AWS SDK clients
// ---------------------------------------------------------------------------
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const mockSend = jest.fn().mockRejectedValue(new Error('Mock: call not expected'));
  return {
    DynamoDBDocumentClient: {
      from: jest.fn().mockReturnValue({ send: mockSend }),
    },
    PutCommand: jest.fn(),
    DeleteCommand: jest.fn(),
    GetCommand: jest.fn(),
    UpdateCommand: jest.fn(),
    QueryCommand: jest.fn(),
  };
});

jest.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockRejectedValue(new Error('Mock: call not expected')),
  })),
  PostToConnectionCommand: jest.fn(),
  GoneException: class GoneException extends Error {
    statusCode = 410;
    constructor() { super('Gone'); this.name = 'GoneException'; }
  },
}));

// Set env vars before importing handlers
process.env.CONNECTIONS_TABLE = 'test-connections-table';
process.env.API_GATEWAY_ENDPOINT = 'test-api-id.execute-api.us-east-1.amazonaws.com/prod';

// Suppress console output
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Import handlers after mocks
// ---------------------------------------------------------------------------
import { handler as connectHandler } from '../services/share/websocket/src/connect';
import { handler as disconnectHandler } from '../services/share/websocket/src/disconnect';
import { handler as defaultHandler } from '../services/share/websocket/src/default';
import { handler as broadcastHandler } from '../services/share/websocket/src/broadcast';

function makeWsEvent(overrides: any = {}): any {
  return {
    requestContext: {
      connectionId: 'test-conn-id',
      routeKey: '$connect',
      ...overrides.requestContext,
    },
    queryStringParameters: overrides.queryStringParameters || {},
    body: overrides.body || null,
    ...overrides,
  };
}

// ===================================================================
// Connect handler — input validation tests
// ===================================================================
describe('connect handler', () => {
  test('rejects invalid shareId with special characters', async () => {
    const event = makeWsEvent({
      queryStringParameters: { shareId: '../../../etc/passwd' },
    });
    const result = await connectHandler(event);
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('Invalid shareId');
  });

  test('rejects shareId exceeding 64 characters', async () => {
    const event = makeWsEvent({
      queryStringParameters: { shareId: 'a'.repeat(65) },
    });
    const result = await connectHandler(event);
    expect(result.statusCode).toBe(400);
  });

  test('rejects shareId with spaces', async () => {
    const event = makeWsEvent({
      queryStringParameters: { shareId: 'has space' },
    });
    const result = await connectHandler(event);
    expect(result.statusCode).toBe(400);
  });

  test('accepts valid shareId with hyphens and underscores', async () => {
    const event = makeWsEvent({
      queryStringParameters: { shareId: 'valid-share_id-123' },
    });
    // Will get 500 because DynamoDB mock rejects, but the shareId validation passed
    const result = await connectHandler(event);
    expect(result.statusCode).toBe(500); // DynamoDB mock error, not 400
  });

  test('returns 500 on DynamoDB error', async () => {
    const event = makeWsEvent({
      queryStringParameters: { shareId: 'valid-id' },
    });
    const result = await connectHandler(event);
    expect(result.statusCode).toBe(500);
  });
});

// ===================================================================
// Disconnect handler tests
// ===================================================================
describe('disconnect handler', () => {
  test('returns 500 on DynamoDB error (confirms handler is invoked)', async () => {
    const event = makeWsEvent({
      requestContext: { connectionId: 'conn-fail', routeKey: '$disconnect' },
    });
    const result = await disconnectHandler(event);
    expect(result.statusCode).toBe(500);
  });
});

// ===================================================================
// Default handler tests
// ===================================================================
describe('default handler', () => {
  test('returns 500 when DynamoDB GetCommand fails (handler catches gracefully)', async () => {
    const event = makeWsEvent({
      body: JSON.stringify({ action: 'ping' }),
    });
    const result = await defaultHandler(event);
    expect(result.statusCode).toBe(500);
  });
});

// ===================================================================
// Broadcast handler tests
// ===================================================================
describe('broadcast handler', () => {
  test('returns 500 when DynamoDB query fails (handler catches gracefully)', async () => {
    const event = { shareId: 'share-1', message: { type: 'sync', timestamp: 1234 } };
    const result = await broadcastHandler(event);
    expect(result.statusCode).toBe(500);
  });
});

// ===================================================================
// ShareId validation regex tests (pure logic, no SDK dependency)
// ===================================================================
describe('shareId validation regex', () => {
  const SHARE_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

  test.each([
    ['abc123', true],
    ['test_share-id', true],
    ['A'.repeat(64), true],
    ['', false],
    ['A'.repeat(65), false],
    ['has space', false],
    ['has.dot', false],
    ['../traversal', false],
    ['<script>alert(1)</script>', false],
    ['valid-id', true],
    ['_underscore_start', true],
    ['-hyphen-start', true],
  ])('shareId "%s" should be %s', (shareId, expected) => {
    expect(SHARE_ID_REGEX.test(shareId)).toBe(expected);
  });
});
