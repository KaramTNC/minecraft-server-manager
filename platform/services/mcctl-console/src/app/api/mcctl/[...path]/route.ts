import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { createMcctlApiClient, McctlApiError } from '@/adapters/McctlApiAdapter';
import { requireAuth, AuthError } from '@/lib/auth-utils';

export const dynamic = 'force-dynamic';

async function forward(request: NextRequest, context: { params: { path: string[] } }) {
  try {
    await requireAuth(await headers());
    const segments = context.params.path ?? [];
    if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
      return NextResponse.json({ error: 'BadRequest', message: 'Invalid management API path.' }, { status: 400 });
    }
    const endpoint = `/${segments.map(encodeURIComponent).join('/')}${request.nextUrl.search}`;
    const bodyText = ['GET', 'HEAD'].includes(request.method) ? '' : await request.text();
    const body = bodyText ? JSON.parse(bodyText) as unknown : undefined;
    const client = createMcctlApiClient();
    const data = await client.proxyRequest<unknown>(endpoint, request.method, body);
    return NextResponse.json(data);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: 'Forbidden', message: error.message }, { status: error.statusCode });
    }
    if (error instanceof McctlApiError) {
      return NextResponse.json({ error: error.error, message: error.message }, { status: error.statusCode });
    }
    console.error('Failed to forward management API request:', error);
    return NextResponse.json({ error: 'InternalServerError', message: 'Management API request failed.' }, { status: 500 });
  }
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
