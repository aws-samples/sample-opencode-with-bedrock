import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import {
  healthHandler,
  createShareHandler,
  syncShareHandler,
  getShareDataHandler,
  deleteShareHandler,
  viewShareHandler,
  landingPageHandler,
} from "./handlers.js";

// Configurable CORS origin
const ALLOWED_ORIGIN = process.env.CORS_ALLOWED_ORIGIN || "*";

// Extract path and method from either ALB (v1) or API Gateway (v2) event formats
function extractRequest(event: any): { path: string; method: string } {
  // ALB sends v1 format: event.path, event.httpMethod
  // API Gateway v2 sends: event.rawPath, event.requestContext.http.method
  const path = event.rawPath || event.path || "/";
  const method =
    event.requestContext?.http?.method || event.httpMethod || "GET";
  return { path, method };
}

// Main Lambda handler - routes requests based on path and method
export async function handler(
  event: any
): Promise<APIGatewayProxyResultV2> {
  const { path: rawPath, method } = extractRequest(event);

  // Log request metadata only (not body/headers which may contain sensitive data)
  console.log("Request:", {
    path: rawPath,
    method,
    sourceIp:
      event.requestContext?.http?.sourceIp ||
      event.requestContext?.identity?.sourceIp,
    requestId: event.requestContext?.requestId,
  });

  // Strip stage prefix if present
  const path = rawPath.replace(/^\/(prod|dev|stage|test)\b/, "") || "/";

  // Also extract pathParameters from ALB path pattern matches
  // ALB doesn't provide pathParameters, so we parse them from the path
  if (!event.pathParameters) {
    const shareIdMatch = path.match(/^\/api\/share\/([^\/]+)/);
    if (shareIdMatch) {
      event.pathParameters = { shareID: shareIdMatch[1] };
    }
    const viewMatch = path.match(/^\/share\/([^\/]+)$/);
    if (viewMatch) {
      event.pathParameters = { shareID: viewMatch[1] };
    }
  }

  try {
    // Health check
    if (path === "/health" && method === "GET") {
      return await healthHandler();
    }

    // Landing page
    if (path === "/" && method === "GET") {
      return await landingPageHandler();
    }

    // API Routes
    if (path === "/api/share" && method === "POST") {
      return await createShareHandler(event);
    }

    if (path.match(/^\/api\/share\/[^\/]+\/sync$/) && method === "POST") {
      return await syncShareHandler(event);
    }

    if (path.match(/^\/api\/share\/[^\/]+\/data$/) && method === "GET") {
      return await getShareDataHandler(event);
    }

    if (path.match(/^\/api\/share\/[^\/]+$/) && method === "DELETE") {
      return await deleteShareHandler(event);
    }

    // View share
    if (path.match(/^\/share\/[^\/]+$/) && method === "GET") {
      return await viewShareHandler(event);
    }

    // Handle OPTIONS for CORS
    if (method === "OPTIONS") {
      return {
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Share-Secret",
        },
        body: "",
      };
    }

    // 404 for unmatched routes
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Not found" }),
    };
  } catch (error) {
    console.error("Unhandled error:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}
