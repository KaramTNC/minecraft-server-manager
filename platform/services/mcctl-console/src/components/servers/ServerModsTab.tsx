'use client';

import { useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Snackbar from '@mui/material/Snackbar';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import ExtensionIcon from '@mui/icons-material/Extension';
import RefreshIcon from '@mui/icons-material/Refresh';
import SettingsIcon from '@mui/icons-material/Settings';
import UpdateIcon from '@mui/icons-material/Update';
import { BentoPanel } from '@/components/bento';
import { TextEditor } from './files/TextEditor';
import {
  useCompatibleModVersions,
  useAdoptExistingMods,
  useDeleteManagedMod,
  useInstallManagedMod,
  useManagedModUpdates,
  useModCompatibility,
  useModConfigFiles,
  useModSearch,
  useModSources,
  useSaveCurseForgeApiKey,
  useSaveModConfigFiles,
  useSetManagedModEnabled,
  useUpdateManagedMods,
  useInstalledMods,
} from '@/hooks/useMods';
import type { InstalledModEntry, ModSearchHit } from '@/ports/api/IMcctlApiClient';

interface ServerModsTabProps { serverName: string }

export function ServerModsTab({ serverName }: ServerModsTabProps) {
  const { data: modsData, isLoading: modsLoading, error: modsError, refetch: refetchMods } = useInstalledMods(serverName);
  const { data: compat } = useModCompatibility(serverName);
  const { data: sourcesData } = useModSources();
  const { data: updatesData, refetch: checkUpdates, isFetching: checkingUpdates } = useManagedModUpdates(serverName);
  const install = useInstallManagedMod();
  const adopt = useAdoptExistingMods();
  const update = useUpdateManagedMods();
  const setEnabled = useSetManagedModEnabled();
  const deleteMod = useDeleteManagedMod();
  const saveKey = useSaveCurseForgeApiKey();

  const [searchOpen, setSearchOpen] = useState(false);
  const [source, setSource] = useState('modrinth');
  const [query, setQuery] = useState('');
  const [selectedProject, setSelectedProject] = useState<ModSearchHit | null>(null);
  const [selectedVersion, setSelectedVersion] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<InstalledModEntry | null>(null);
  const [configMod, setConfigMod] = useState<InstalledModEntry | null>(null);
  const [selectedConfigs, setSelectedConfigs] = useState<string[]>([]);
  const [editingConfig, setEditingConfig] = useState<string | null>(null);
  const [curseForgeKey, setCurseForgeKey] = useState('');
  const [notice, setNotice] = useState<{ text: string; severity: 'success' | 'error' | 'info' } | null>(null);

  const { data: searchData, isLoading: searching } = useModSearch(query, {
    source, serverName, limit: 15, enabled: searchOpen && query.trim().length > 0,
  });
  const selectedProjectId = selectedProject?.sourceId ?? selectedProject?.slug ?? '';
  const { data: versionData, isLoading: loadingVersions } = useCompatibleModVersions(
    selectedProjectId, source, serverName, searchOpen && !!selectedProjectId,
  );
  const { data: configData, isLoading: loadingConfig } = useModConfigFiles(serverName, configMod?.filename ?? null);
  const saveConfigs = useSaveModConfigFiles();

  const updateByFilename = useMemo(() => new Map((updatesData?.updates ?? []).map((item) => [item.filename, item])), [updatesData]);
  const availableSource = sourcesData?.sources.find((item) => item.id === source);

  useEffect(() => {
    if (!versionData?.versions.length) {
      setSelectedVersion('');
      return;
    }
    if (!versionData.versions.some((version) => version.id === selectedVersion)) {
      const preferred = versionData.versions.find((version) => version.versionType === 'release') ?? versionData.versions[0];
      setSelectedVersion(preferred?.id ?? '');
    }
  }, [versionData, selectedVersion]);

  useEffect(() => {
    setSelectedConfigs(configData?.selected ?? []);
  }, [configData?.selected, configMod?.filename]);

  const showError = (error: unknown, fallback: string) => setNotice({
    text: error instanceof Error ? error.message : fallback, severity: 'error',
  });

  const handleInstall = async () => {
    if (!selectedProject || !selectedVersion) return;
    try {
      await install.mutateAsync({
        serverName, source, projectId: selectedProject.sourceId ?? selectedProject.slug, versionId: selectedVersion,
      });
      setNotice({ text: `${selectedProject.title} installed and checksum verified. Restart the server to load it.`, severity: 'success' });
      setSelectedProject(null);
      setQuery('');
      setSearchOpen(false);
      void refetchMods();
    } catch (error) { showError(error, 'Mod installation failed.'); }
  };

  const handleToggle = async (mod: InstalledModEntry) => {
    try {
      await setEnabled.mutateAsync({ serverName, filename: mod.filename, enabled: !mod.enabled });
      setNotice({ text: `${mod.title || mod.filename} ${mod.enabled ? 'disabled' : 'enabled'}. Restart the server to apply the change.`, severity: 'info' });
      void refetchMods();
    } catch (error) { showError(error, 'Unable to change mod state.'); }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      await deleteMod.mutateAsync({ serverName, filename: confirmDelete.filename });
      setNotice({ text: `${confirmDelete.title || confirmDelete.filename} deleted. Restart the server to apply the change.`, severity: 'info' });
      setConfirmDelete(null);
      void refetchMods();
    } catch (error) { showError(error, 'Unable to delete mod.'); }
  };

  const openConfig = (mod: InstalledModEntry) => {
    setConfigMod(mod);
    setEditingConfig(null);
    setSelectedConfigs(mod.configFiles ?? []);
  };

  const saveCurseForgeKey = async () => {
    try {
      await saveKey.mutateAsync({ apiKey: curseForgeKey });
      setCurseForgeKey('');
      setNotice({ text: 'CurseForge is connected. The API key is stored in the private platform environment file.', severity: 'success' });
    } catch (error) { showError(error, 'Unable to save CurseForge API key.'); }
  };

  const handleConfigSave = async () => {
    if (!configMod) return;
    try {
      await saveConfigs.mutateAsync({ serverName, filename: configMod.filename, files: selectedConfigs });
      setNotice({ text: 'Mod configuration links saved. Open a file to edit its native format.', severity: 'success' });
    } catch (error) { showError(error, 'Unable to save mod configuration links.'); }
  };

  const updateAll = async () => {
    const targets = (updatesData?.updates ?? []).filter((item) => item.updateAvailable).map((item) => item.filename);
    if (!targets.length) return;
    try {
      const result = await update.mutateAsync({ serverName, filenames: targets }) as { updated?: InstalledModEntry[]; unchanged?: string[] };
      setNotice({ text: `${result.updated?.length ?? 0} mod(s) updated. Restart the server to load them.`, severity: 'success' });
    } catch (error) { showError(error, 'Mod update failed.'); }
  };

  if (modsLoading) return <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>;
  if (modsError) return <Alert severity="error">Failed to load mods: {modsError.message}</Alert>;

  const mods = modsData?.mods ?? [];
  const updateCount = updatesData?.updates.filter((item) => item.updateAvailable).length ?? 0;
  const untrackedCount = mods.filter((mod) => !mod.managed).length;

  return (
    <Box>
      <BentoPanel>
        <Box sx={{ p: 2.5 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
            <Box>
              <Typography variant="h6" fontWeight={600}>Mods</Typography>
              <Typography variant="body2" color="text.secondary">
                {compat ? `Minecraft ${compat.gameVersion} · ${compat.loader}` : 'Checking server compatibility…'}
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <Button variant="outlined" startIcon={<RefreshIcon />} onClick={() => void checkUpdates()} disabled={checkingUpdates || !compat}>
                {checkingUpdates ? 'Checking…' : 'Check updates'}
              </Button>
              <Button variant="outlined" startIcon={<UpdateIcon />} onClick={() => void updateAll()} disabled={!updateCount || update.isPending}>
                Update all{updateCount ? ` (${updateCount})` : ''}
              </Button>
              {untrackedCount > 0 && <Button variant="outlined" onClick={() => void adopt.mutateAsync({ serverName }).then((result) => setNotice({ text: `Matched ${result.adopted.length} existing Modrinth mod(s); ${result.unrecognized.length} JAR(s) remain unmatched.`, severity: 'info' })).catch((error) => showError(error, 'Could not identify existing mods.'))} disabled={adopt.isPending}>{adopt.isPending ? 'Identifying…' : `Identify existing (${untrackedCount})`}</Button>}
              <Button variant="contained" startIcon={<AddIcon />} onClick={() => { setSelectedProject(null); setQuery(''); setSearchOpen(true); }}>
                Add mod
              </Button>
            </Box>
          </Box>
          {!compat && <Alert severity="warning" sx={{ mt: 2 }}>Set an exact Minecraft version and supported mod loader in Server settings before installing mods.</Alert>}
          {sourcesData?.sources.find((item) => item.id === 'curseforge')?.requiresApiKey && (
            <Alert severity="info" sx={{ mt: 2 }}>
              CurseForge requires an API key. Create one at <a href="https://console.curseforge.com/" target="_blank" rel="noreferrer">console.curseforge.com</a>, then enter it in the publisher selector.
            </Alert>
          )}
          {mods.length === 0 ? (
            <Box sx={{ textAlign: 'center', py: 5 }}>
              <ExtensionIcon sx={{ fontSize: 48, color: 'text.disabled', mb: 1 }} />
              <Typography>No mod JARs found</Typography>
              <Typography variant="body2" color="text.secondary">Add a compatible version from a supported publisher.</Typography>
            </Box>
          ) : (
            <Box sx={{ mt: 2 }}>
              <Divider sx={{ mb: 1 }} />
              {mods.map((mod: InstalledModEntry) => {
                const modUpdate = updateByFilename.get(mod.filename);
                return (
                  <Box key={mod.filename} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 1.25, borderBottom: 1, borderColor: 'divider', opacity: mod.enabled === false ? 0.62 : 1 }}>
                    <ExtensionIcon color={mod.enabled === false ? 'disabled' : 'action'} />
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography variant="subtitle2" noWrap>{mod.title || mod.filename}</Typography>
                      <Typography variant="caption" color="text.secondary" noWrap>
                        {mod.filename}{mod.version ? ` · ${mod.version}` : ''}{mod.source ? ` · ${mod.source}` : ' · existing JAR'}
                      </Typography>
                      {modUpdate?.updateAvailable && <Chip size="small" color="primary" label={`Update: ${modUpdate.latestVersion}`} sx={{ ml: 1, height: 20 }} />}
                    </Box>
                    {modUpdate?.updateAvailable && <Tooltip title="Update this mod"><IconButton size="small" onClick={() => void update.mutateAsync({ serverName, filenames: [mod.filename] }).then(() => setNotice({ text: `${mod.title || mod.filename} updated. Restart the server to load it.`, severity: 'success' })).catch((error) => showError(error, 'Update failed.'))}><UpdateIcon fontSize="small" /></IconButton></Tooltip>}
                    <Tooltip title="Choose and edit this mod’s config files"><IconButton size="small" onClick={() => openConfig(mod)}><SettingsIcon fontSize="small" /></IconButton></Tooltip>
                    <FormControlLabel
                      control={<Switch size="small" checked={mod.enabled !== false} onChange={() => void handleToggle(mod)} disabled={setEnabled.isPending} />}
                      label={<Typography variant="caption">{mod.enabled === false ? 'Disabled' : 'Enabled'}</Typography>}
                      labelPlacement="start" sx={{ m: 0, gap: 0.5 }}
                    />
                    <Tooltip title="Delete mod JAR"><IconButton size="small" color="error" onClick={() => setConfirmDelete(mod)}><DeleteIcon fontSize="small" /></IconButton></Tooltip>
                  </Box>
                );
              })}
            </Box>
          )}
        </Box>
      </BentoPanel>

      <Dialog open={searchOpen} onClose={() => setSearchOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>Add a compatible mod</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', gap: 2, mb: 2, mt: 1 }}>
            <FormControl sx={{ minWidth: 180 }}>
              <InputLabel>Publisher</InputLabel>
              <Select value={source} label="Publisher" onChange={(event) => { setSource(event.target.value); setSelectedProject(null); setSelectedVersion(''); }}>
                {(sourcesData?.sources ?? []).map((item) => <MenuItem key={item.id} value={item.id}>{item.name}{!item.available && item.requiresApiKey ? ' · API key needed' : ''}</MenuItem>)}
              </Select>
            </FormControl>
            <TextField fullWidth autoFocus label="Search mods" placeholder={`Search ${availableSource?.name ?? 'publisher'}…`} value={query} onChange={(event) => { setQuery(event.target.value); setSelectedProject(null); setSelectedVersion(''); }} />
          </Box>
          {source === 'curseforge' && availableSource?.requiresApiKey && (
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', mb: 2 }}>
              <TextField fullWidth type="password" label="CurseForge API key" value={curseForgeKey} onChange={(event) => setCurseForgeKey(event.target.value)} autoComplete="new-password" />
              <Button variant="outlined" onClick={() => void saveCurseForgeKey()} disabled={!curseForgeKey || saveKey.isPending}>{saveKey.isPending ? 'Saving…' : 'Connect'}</Button>
            </Box>
          )}
          {searching && <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><CircularProgress size={26} /></Box>}
          <Box sx={{ display: 'grid', gap: 1 }}>
            {(searchData?.hits ?? []).map((hit) => (
              <BentoPanel key={`${hit.sourceName ?? source}:${hit.sourceId ?? hit.slug}`} sx={{ p: 1.5, cursor: 'pointer', border: selectedProject?.slug === hit.slug ? 1 : undefined, borderColor: 'primary.main' }} onClick={() => { setSelectedProject(hit); setSelectedVersion(''); }}>
                <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center' }}>
                  <Avatar src={hit.iconUrl ?? undefined} variant="rounded"><ExtensionIcon /></Avatar>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography fontWeight={600}>{hit.title}</Typography>
                    <Typography variant="body2" color="text.secondary" noWrap>{hit.description}</Typography>
                  </Box>
                  <Chip size="small" label={availableSource?.name ?? source} />
                </Box>
              </BentoPanel>
            ))}
            {!searching && query && !searchData?.hits.length && <Typography color="text.secondary" sx={{ py: 2 }}>No compatible mods found for this server.</Typography>}
          </Box>
          {selectedProject && (
            <Box sx={{ display: 'flex', gap: 2, mt: 2, alignItems: 'center' }}>
              <FormControl fullWidth>
                <InputLabel>Compatible version</InputLabel>
                <Select value={selectedVersion} label="Compatible version" onChange={(event) => setSelectedVersion(event.target.value)}>
                  {(versionData?.versions ?? []).map((version) => <MenuItem key={version.id} value={version.id}>{version.versionNumber} · {version.versionType} · {new Date(version.datePublished).toLocaleDateString()}</MenuItem>)}
                </Select>
              </FormControl>
              <Button variant="contained" onClick={() => void handleInstall()} disabled={!selectedVersion || install.isPending || loadingVersions}>
                {install.isPending ? 'Verifying…' : 'Install'}
              </Button>
            </Box>
          )}
          {selectedProject && loadingVersions && <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>Checking game version and loader compatibility…</Typography>}
        </DialogContent>
        <DialogActions><Button onClick={() => setSearchOpen(false)}>Close</Button></DialogActions>
      </Dialog>

      <Dialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete mod file?</DialogTitle>
        <DialogContent><Typography>Delete {confirmDelete?.filename} from this server? This applies on the next restart.</Typography></DialogContent>
        <DialogActions><Button onClick={() => setConfirmDelete(null)}>Cancel</Button><Button color="error" onClick={() => void handleDelete()} disabled={deleteMod.isPending}>Delete</Button></DialogActions>
      </Dialog>

      <Dialog open={!!configMod} onClose={() => { setConfigMod(null); setEditingConfig(null); }} fullWidth maxWidth={editingConfig ? 'xl' : 'md'} fullScreen={!!editingConfig}>
        {editingConfig ? (
          <TextEditor serverName={serverName} filePath={`/${editingConfig}`} onBack={() => setEditingConfig(null)} />
        ) : (
          <>
            <DialogTitle>Configuration files · {configMod?.title || configMod?.filename}</DialogTitle>
            <DialogContent>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>Select the files this mod uses. They stay in their original JSON, TOML, YAML, or properties format.</Typography>
              {loadingConfig ? <CircularProgress size={24} /> : configData?.files.length ? configData.files.map((file) => (
                <Box key={file} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Checkbox checked={selectedConfigs.includes(file)} onChange={(event) => setSelectedConfigs((current) => event.target.checked ? [...current, file] : current.filter((item) => item !== file))} />
                  <Typography sx={{ flex: 1, fontFamily: 'monospace', fontSize: '0.85rem' }}>{file}</Typography>
                  <Button size="small" onClick={() => setEditingConfig(file)}>Open</Button>
                </Box>
              )) : <Alert severity="info">No text config files exist under the server’s config directory yet. Some mods create them after the first server start.</Alert>}
            </DialogContent>
            <DialogActions><Button onClick={() => setConfigMod(null)}>Close</Button><Button onClick={() => void handleConfigSave()} disabled={saveConfigs.isPending}>{saveConfigs.isPending ? 'Saving…' : 'Save mod links'}</Button></DialogActions>
          </>
        )}
      </Dialog>

      <Snackbar open={!!notice} autoHideDuration={6000} onClose={() => setNotice(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        {notice ? <Alert severity={notice.severity} onClose={() => setNotice(null)} variant="filled">{notice.text}</Alert> : undefined}
      </Snackbar>
    </Box>
  );
}
