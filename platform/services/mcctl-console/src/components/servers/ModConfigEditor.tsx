'use client';

import { useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Grid from '@mui/material/Grid';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CodeIcon from '@mui/icons-material/Code';
import SaveIcon from '@mui/icons-material/Save';
import { BentoPanel } from '@/components/bento';
import { useFileContent, useWriteFile } from '@/hooks/use-server-files';
import { TextEditor } from './files/TextEditor';

type Scalar = string | number | boolean | null;
type FieldType = 'boolean' | 'number' | 'string' | 'complex';

interface ConfigField {
  id: string;
  group: string;
  label: string;
  value: Scalar;
  type: FieldType;
  path?: string[];
  lineIndex?: number;
  prefix?: string;
  suffix?: string;
  quote?: '"' | "'";
}

interface ConfigDocument {
  format: 'json' | 'lines';
  fields: ConfigField[];
  value: unknown;
}

function humanize(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function inferField(value: unknown): FieldType {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  return 'complex';
}

function separateTomlComment(raw: string): { value: string; suffix: string } {
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && quote === '"') { escaped = true; continue; }
    if ((char === '"' || char === "'") && (!quote || quote === char)) { quote = quote ? null : char; continue; }
    if (char === '#' && !quote && (index === 0 || /\s/.test(raw[index - 1]))) {
      let start = index;
      while (start > 0 && /\s/.test(raw[start - 1])) start -= 1;
      return { value: raw.slice(0, start), suffix: raw.slice(start) };
    }
  }
  return { value: raw, suffix: '' };
}

function parseDocument(content: string, filePath: string): ConfigDocument | null {
  const extension = filePath.split('.').pop()?.toLowerCase();
  if (extension === 'json') {
    try {
      const value: unknown = JSON.parse(content);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const fields: ConfigField[] = [];
      const visit = (node: Record<string, unknown>, path: string[]) => {
        for (const [key, child] of Object.entries(node)) {
          const childPath = [...path, key];
          if (child && typeof child === 'object' && !Array.isArray(child)) visit(child as Record<string, unknown>, childPath);
          else fields.push({
            id: childPath.join('.'),
            group: path[0] ? humanize(path[0]) : 'General',
            label: humanize(key),
            value: (child ?? null) as Scalar,
            type: inferField(child),
            path: childPath,
          });
        }
      };
      visit(value as Record<string, unknown>, []);
      return { format: 'json', fields, value };
    } catch { return null; }
  }

  if (!['toml', 'properties', 'ini', 'cfg', 'conf'].includes(extension ?? '')) return null;
  const fields: ConfigField[] = [];
  let group = 'General';
  const lines = content.split(/\r?\n/);
  lines.forEach((line, lineIndex) => {
    const section = line.match(/^\s*\[{1,2}([^\]]+)\]{1,2}\s*(?:[#;].*)?$/);
    if (section) { group = humanize(section[1]); return; }
    const match = line.match(/^(\s*[^=:#\s][^=:#]*?\s*[=:]\s*)(.*)$/);
    if (!match || /^\s*[#;]/.test(line)) return;
    const separated = extension === 'toml' ? separateTomlComment(match[2]) : { value: match[2], suffix: '' };
    const raw = separated.value;
    const id = `line:${lineIndex}`;
    const clean = raw.trim();
    let value: Scalar = clean;
    let type: FieldType = 'complex';
    let quote: ConfigField['quote'];
    if (/^(true|false)$/i.test(clean)) { value = clean.toLowerCase() === 'true'; type = 'boolean'; }
    else if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(clean)) { value = Number(clean); type = 'number'; }
    else if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
      quote = clean[0] as '"' | "'";
      value = clean.slice(1, -1);
      type = 'string';
    } else if (extension === 'properties' || extension === 'ini' || extension === 'cfg' || extension === 'conf') {
      value = clean;
      type = 'string';
    }
    fields.push({ id, group, label: humanize(match[1].replace(/[=:]\s*$/, '').trim()), value, type, lineIndex, prefix: match[1], suffix: separated.suffix, quote });
  });
  return { format: 'lines', fields, value: lines };
}

function setObjectPath(root: Record<string, unknown>, path: string[], value: unknown): void {
  let current = root;
  for (const part of path.slice(0, -1)) {
    const next = current[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[path[path.length - 1]] = value;
}

function serializeValue(field: ConfigField, value: unknown): string {
  if (field.type === 'boolean') return value ? 'true' : 'false';
  if (field.type === 'number') return String(value ?? 0);
  if (field.quote) return field.quote === '"' ? JSON.stringify(String(value ?? '')) : `'${String(value ?? '').replace(/'/g, "\\'")}'`;
  return String(value ?? '');
}

function buildContent(original: string, document: ConfigDocument, values: Record<string, unknown>): string {
  if (document.format === 'json') {
    const root = JSON.parse(original) as Record<string, unknown>;
    for (const field of document.fields) if (field.path) setObjectPath(root, field.path, values[field.id]);
    return `${JSON.stringify(root, null, 2)}${original.endsWith('\n') ? '\n' : ''}`;
  }
  const lines = original.split(/\r?\n/);
  for (const field of document.fields) {
    if (field.lineIndex == null || field.type === 'complex') continue;
    lines[field.lineIndex] = `${field.prefix}${serializeValue(field, values[field.id])}${field.suffix ?? ''}`;
  }
  return lines.join(original.includes('\r\n') ? '\r\n' : '\n');
}

interface ModConfigEditorProps {
  serverName: string;
  filePath: string;
  onBack: () => void;
}

export function ModConfigEditor({ serverName, filePath, onBack }: ModConfigEditorProps) {
  const { data, isLoading, error } = useFileContent(serverName, `/${filePath}`);
  const writeFile = useWriteFile(serverName);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [rawMode, setRawMode] = useState(false);
  const document = useMemo(() => data ? parseDocument(data.content, filePath) : null, [data, filePath]);

  useEffect(() => {
    if (document) setValues(Object.fromEntries(document.fields.map((field) => [field.id, field.value])));
  }, [document]);

  const groups = useMemo(() => {
    const result = new Map<string, ConfigField[]>();
    for (const field of document?.fields ?? []) result.set(field.group, [...(result.get(field.group) ?? []), field]);
    return Array.from(result.entries());
  }, [document]);

  if (rawMode) return <TextEditor serverName={serverName} filePath={`/${filePath}`} onBack={() => setRawMode(false)} />;

  const changed = !!data && !!document && buildContent(data.content, document, values) !== data.content;
  const save = () => {
    if (!data || !document) return;
    writeFile.mutate({ path: `/${filePath}`, content: buildContent(data.content, document, values) });
  };
  const format = filePath.split('.').pop()?.toUpperCase() ?? 'TEXT';

  return (
    <Box sx={{ minHeight: '100%', bgcolor: 'background.default', p: { xs: 1.5, md: 3 }, overflowY: 'auto' }}>
      <Box sx={{ maxWidth: 1080, mx: 'auto' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2.5, flexWrap: 'wrap' }}>
          <Button startIcon={<ArrowBackIcon />} onClick={onBack}>Back to mods</Button>
          <Box sx={{ flex: 1, minWidth: 220 }}>
            <Typography variant="h5" fontWeight={650}>{humanize(filePath.split('/').pop() ?? filePath)}</Typography>
            <Typography variant="body2" color="text.secondary">{filePath}</Typography>
          </Box>
          <Button startIcon={<CodeIcon />} onClick={() => setRawMode(true)} disabled={changed}>Raw file</Button>
          <Button variant="contained" startIcon={writeFile.isPending ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />} onClick={save} disabled={!changed || writeFile.isPending}>
            {writeFile.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </Box>
        <Alert severity="info" sx={{ mb: 2.5 }}>
          Edit {format} settings with typed controls. Changes keep the file in its native format and usually need a server restart.
        </Alert>
        {isLoading && <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>}
        {error && <Alert severity="error">Could not load this config: {error.message}</Alert>}
        {writeFile.isError && <Alert severity="error" sx={{ mb: 2 }}>Could not save config: {writeFile.error.message}</Alert>}
        {writeFile.isSuccess && !changed && <Alert severity="success" sx={{ mb: 2 }}>Config saved.</Alert>}
        {data && !document && <Alert severity="warning">This file can’t be safely shown as a settings form. Open it in the raw editor instead.</Alert>}
        {document && document.fields.length === 0 && <Alert severity="info">This config has no editable settings yet.</Alert>}
        {groups.map(([group, fields]) => (
          <BentoPanel key={group} sx={{ mb: 2.5 }}>
            <Box sx={{ p: { xs: 2, md: 2.5 } }}>
              <Typography variant="h6" fontWeight={600}>{group}</Typography>
              <Divider sx={{ my: 2 }} />
              <Grid container spacing={2.5}>
                {fields.map((field) => (
                  <Grid item key={field.id} xs={12} sm={field.type === 'boolean' ? 6 : 12}>
                    {field.type === 'boolean' ? (
                      <Box sx={{ minHeight: 56, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, borderBottom: 1, borderColor: 'divider' }}>
                        <Box>
                          <Typography variant="subtitle2">{field.label}</Typography>
                          <Typography variant="caption" color="text.secondary">{field.id.replace(/^line:\d+$/, '') || field.group}</Typography>
                        </Box>
                        <Switch checked={Boolean(values[field.id])} onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.checked }))} inputProps={{ 'aria-label': field.label }} />
                      </Box>
                    ) : (
                      <TextField
                        fullWidth
                        size="small"
                        label={field.label}
                        type={field.type === 'number' ? 'number' : 'text'}
                        value={field.type === 'complex' ? String(field.value ?? '') : String(values[field.id] ?? '')}
                        onChange={(event) => setValues((current) => ({ ...current, [field.id]: field.type === 'number' ? (event.target.value === '' ? '' : Number(event.target.value)) : event.target.value }))}
                        disabled={field.type === 'complex'}
                        multiline={field.type === 'complex'}
                        minRows={field.type === 'complex' ? 2 : undefined}
                        helperText={field.type === 'complex' ? 'Use Raw file to edit this structured value.' : field.type === 'number' ? 'Numeric setting' : 'Text setting'}
                      />
                    )}
                  </Grid>
                ))}
              </Grid>
            </Box>
          </BentoPanel>
        ))}
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, pb: 2 }}>
          <Button onClick={() => setValues(Object.fromEntries((document?.fields ?? []).map((field) => [field.id, field.value])))} disabled={!changed}>Discard</Button>
          <Button variant="contained" startIcon={<SaveIcon />} onClick={save} disabled={!changed || writeFile.isPending}>Save changes</Button>
        </Box>
      </Box>
    </Box>
  );
}
