import { create, fromJson, toJson } from '@bufbuild/protobuf';
import type { DescMessage, MessageInitShape } from '@bufbuild/protobuf';
import type { Route } from '@playwright/test';

// Fixtures use the same generated descriptors as the browser, including presence and uint64 rules.
export function respond<Schema extends DescMessage>(route: Route, schema: Schema, message: MessageInitShape<Schema>) {
  return route.fulfill({ status: 200, contentType: 'application/json', json: toJson(schema, create(schema, message)) });
}
export function request<Schema extends DescMessage>(route: Route, schema: Schema) {
  return fromJson(schema, route.request().postDataJSON());
}
export function reject(route: Route, code: 'unauthenticated' | 'permission_denied' | 'not_found' | 'already_exists' | 'failed_precondition' | 'resource_exhausted' | 'unavailable', message: string) {
  const status = { unauthenticated: 401, permission_denied: 403, not_found: 404, already_exists: 409, failed_precondition: 400, resource_exhausted: 429, unavailable: 503 }[code];
  return route.fulfill({ status, contentType: 'application/json', json: { code, message } });
}
