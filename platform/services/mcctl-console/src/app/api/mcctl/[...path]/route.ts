import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { createMcctlApiClient, McctlApiError } from '@/adapters/McctlApiAdapter';
import { requireAdmin, requireAuth, requireServerPermission, AuthError } from '@/lib/auth-utils';

export const dynamic = 'force-dynamic';

async function forward(request: NextRequest, context: { params: { path: string[] } }) {
  try {
    const requestHeaders = await headers();
    const segments = context.params.path ?? [];
    if (segments.length === 0 || segments.some((segment) => !segment || segment === '.' || segment === '..' || /[\\/\0]/.test(segment))) {
      return NextResponse.json({ error: 'BadRequest', message: 'Invalid management API path.' }, { status: 400 });
    }

    const method = request.method.toUpperCase();
    let permission: 'view' | 'manage' | 'admin' | 'auth' | null = null;
    let serverName: string | null = null;
    if (segments.length === 2 && segments[0] === 'mods' && segments[1] === 'sources' && method === 'GET') {
      permission = 'auth';
    } else if (segments.length === 3 && segments[0] === 'mods' && segments[1] === 'sources' && segments[2] === 'curseforge-key' && method === 'PUT') {
      permission = 'admin';
    } else if (segments.length === 3 && segments[0] === 'mods' && segments[2] === 'compatible-versions' && method === 'GET') {
      serverName = request.nextUrl.searchParams.get('serverName');
      permission = 'view';
    } else if (segments[0] === 'servers' && segments[2] === 'mods' && segments.length >= 4) {
      serverName = segments[1] ?? null;
      const resource = segments[3];
      const readOnly = (resource === 'compatibility' || resource === 'installed' && segments.length === 4 || resource === 'updates') && method === 'GET';
      const configRead = resource === 'installed' && segments.length === 6 && segments[5] === 'configs' && method === 'GET';
      const configWrite = resource === 'installed' && segments.length === 6 && segments[5] === 'configs' && method === 'PUT';
      const stateChange = resource === 'installed' && segments.length === 6 && segments[5] === 'state' && method === 'PATCH';
      const exclusionChange = resource === 'installed' && segments.length === 6 && segments[5] === 'exclude' && method === 'PATCH';
      const fileDelete = resource === 'installed' && segments.length === 5 && method === 'DELETE';
      const modChange = ['manage', 'adopt', 'update'].includes(resource) && segments.length === 4 && ['POST'].includes(method);
      if (readOnly || configRead) permission = 'view';
      else if (configWrite || stateChange || exclusionChange || fileDelete || modChange) permission = 'manage';
    }

    if (!permission) {
      return NextResponse.json({ error: 'NotFound', message: 'Management API route not found.' }, { status: 404 });
    }
    if (permission === 'admin') await requireAdmin(requestHeaders);
    else if (permission === 'auth') await requireAuth(requestHeaders);
    else if (serverName) await requireServerPermission(requestHeaders, serverName, permission);
    else return NextResponse.json({ error: 'BadRequest', message: 'serverName is required.' }, { status: 400 });

    const endpoint = `/${segments.map(encodeURIComponent).join('/')}${request.nextUrl.search}`;
    const bodyText = ['GET', 'HEAD'].includes(method) ? '' : await request.text();
    let body: unknown;
    try { body = bodyText ? JSON.parse(bodyText) as unknown : undefined; }
    catch { return NextResponse.json({ error: 'BadRequest', message: 'Request body must be valid JSON.' }, { status: 400 }); }
    const client = createMcctlApiClient();
    const data = await client.proxyRequest<unknown>(endpoint, method, body);
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
