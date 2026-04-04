import { getDesktopInstallSkillsConfig } from './desktop-settings-api';

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

declare global {
  interface Window {
    __TAURI__?: {
      core?: {
        invoke?: TauriInvoke;
      };
    };
    __TAURI_INTERNALS__?: {
      invoke?: TauriInvoke;
    };
  }
}

export interface RecommendedSkillItem {
  slug: string;
  name: string;
  description?: string;
  version?: string;
  homepage?: string;
  owner?: string;
  tags?: string[];
  downloads?: number;
  source?: string;
  updatedAt?: string;
}

export interface LocalSkillItem {
  slug: string;
  name: string;
  version?: string;
  enabled?: boolean;
  path?: string;
}

export interface DesktopSkillsCatalog {
  mode: string;
  notes?: string;
  updatedAt?: string;
  items: RecommendedSkillItem[];
  skillhub?: {
    siteUrl?: string;
    installerUrl?: string;
  };
}

export interface SkillCompareItem extends RecommendedSkillItem {
  installStatus: 'installed' | 'not-installed';
  localVersion?: string;
  enabled?: boolean;
  path?: string;
  recommended: boolean;
}

export interface InstallSkillOptions {
  installerUrl?: string;
}

function getInvoke(): TauriInvoke | null {
  return window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke ?? null;
}

function normalizeSlug(value: string) {
  return value.trim();
}

function normalizeText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOptionalText(value: unknown) {
  const normalized = normalizeText(value);
  return normalized || undefined;
}

function normalizeTags(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function normalizeDownloads(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function isUsableSkillSlug(value: string) {
  return value.length > 0 && value !== '[object Object]';
}

export async function getDesktopSkillsCatalog(): Promise<DesktopSkillsCatalog> {
  const payload = await getDesktopInstallSkillsConfig();

  return {
    mode: payload.mode,
    notes: payload.notes,
    updatedAt: payload.updatedAt,
    skillhub: payload.skillhub,
    items: (payload.skills || [])
      .map((item) => {
        if (typeof item === 'string') {
          const slug = normalizeSlug(item);
          return {
            slug,
            name: slug,
            description: '',
            version: undefined,
            homepage: undefined,
            owner: undefined,
            tags: [],
            downloads: undefined,
            source: undefined,
            updatedAt: undefined,
          } satisfies RecommendedSkillItem;
        }

        const slug = normalizeText(item.slug);
        return {
          slug,
          name: normalizeText(item.name) || slug,
          description: normalizeText(item.description),
          version: normalizeOptionalText(item.version),
          homepage: normalizeOptionalText(item.homepage),
          owner: normalizeOptionalText(item.owner),
          tags: normalizeTags(item.tags),
          downloads: normalizeDownloads(item.downloads),
          source: normalizeOptionalText(item.source),
          updatedAt: item.updatedAt || undefined,
        } satisfies RecommendedSkillItem;
      })
      .filter((item) => isUsableSkillSlug(item.slug)),
  };
}

export async function getLocalSkills(): Promise<LocalSkillItem[]> {
  const invoke = getInvoke();
  if (!invoke) {
    return [];
  }

  return invoke<LocalSkillItem[]>('list_local_skills');
}

export async function installSkill(slug: string, options: InstallSkillOptions = {}): Promise<LocalSkillItem[]> {
  const invoke = getInvoke();
  if (!invoke) {
    throw new Error('当前为浏览器联调壳层，无法安装技能。');
  }

  return invoke<LocalSkillItem[]>('install_skill', {
    slug,
    installerUrl: options.installerUrl,
  });
}

export async function uninstallSkill(slug: string): Promise<LocalSkillItem[]> {
  const invoke = getInvoke();
  if (!invoke) {
    throw new Error('当前为浏览器联调壳层，无法卸载技能。');
  }

  return invoke<LocalSkillItem[]>('uninstall_skill', { slug });
}

export function mergeRecommendedAndLocalSkills(
  recommended: RecommendedSkillItem[],
  local: LocalSkillItem[],
): SkillCompareItem[] {
  const localSkillMap = new Map<string, LocalSkillItem>();
  for (const item of local) {
    const slug = normalizeSlug(item.slug || '');
    if (!slug || localSkillMap.has(slug)) {
      continue;
    }

    localSkillMap.set(slug, {
      ...item,
      slug,
      name: item.name?.trim() || slug,
    });
  }

  const seenRecommended = new Set<string>();
  const recommendedItems: SkillCompareItem[] = recommended
    .map((item) => ({
      ...item,
      slug: normalizeSlug(item.slug),
      name: item.name?.trim() || normalizeSlug(item.slug),
      description: item.description?.trim() || '',
      tags: item.tags?.filter(Boolean) || [],
    }))
    .filter((item) => {
      if (!isUsableSkillSlug(item.slug) || seenRecommended.has(item.slug)) {
        return false;
      }

      seenRecommended.add(item.slug);
      return true;
    })
    .map((item) => {
      const localItem = localSkillMap.get(item.slug);
      return {
        ...item,
        installStatus: localItem ? 'installed' : 'not-installed',
        localVersion: localItem?.version,
        enabled: localItem?.enabled,
        path: localItem?.path,
        recommended: true,
      } satisfies SkillCompareItem;
    });

  return recommendedItems;
}