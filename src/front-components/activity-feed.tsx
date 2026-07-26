import { defineFrontComponent } from 'twenty-sdk/define';
import {
  getApplicationVariable,
  msg,
  t,
  openSidePanelPage,
  SidePanelPages,
  useColorScheme,
  useUserId,
} from 'twenty-sdk/front-component';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';
// Named imports only: `useIcons` and `IconsProvider` drag in the whole Tabler
// set, several megabytes of it. twenty-ui re-exports a curated subset, and the
// per-format `IconFileTypePdf` family is not part of it — those are drawn
// below. These two are, and a link is exactly what they mean.
import { IconBrandGoogle, IconFile, IconLink } from 'twenty-ui/icon';

import { ACTIVITY_FEED_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';

// Everything below comes from the app's Settings tab, with the manifest
// default as the fallback.
//
// The host injects the values still encrypted — `enc:v2:<workspace>:<blob>` —
// and nothing in twenty-sdk or twenty-client-sdk decrypts them, so a front
// component simply cannot read what an admin typed. Verified by printing the
// raw payload in the panel. Treating a ciphertext as a value is what turned
// SHOW_ATTACHMENTS off and kept every file out of the feed: the string is
// neither `'true'` nor a number, so every setting silently read as false or
// NaN. Until Twenty decrypts these, an unreadable value means "not set".
const readSetting = (key: string): unknown => {
  const raw: unknown = getApplicationVariable(key);

  return typeof raw === 'string' && raw.startsWith('enc:') ? undefined : raw;
};

const readNumberSetting = (key: string, fallback: number) => {
  const parsed = Number(readSetting(key));

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const readBooleanSetting = (key: string, fallback: boolean) => {
  const raw = readSetting(key);

  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }

  return typeof raw === 'boolean' ? raw : String(raw).toLowerCase() === 'true';
};

// Thirty seconds, not fifteen. The panel stays open all day, and each cycle
// parses a few hundred kilobytes of JSON into objects the sandbox then has to
// collect — that churn is what made Safari reclaim the tab.
const POLL_INTERVAL_MS = readNumberSetting('POLL_INTERVAL_SECONDS', 30) * 1000;
const PAGE_SIZE = readNumberSetting('PAGE_SIZE', 50);
// What the feed holds, deliberately fixed. Paging further back turned the
// panel into an archive nobody scrolled: a hundred latest events is what a
// person actually catches up on, and one request keeps them exact — no gaps
// between pages, no duplicates when a new event arrives mid-scroll.
const FEED_LIMIT = 100;
const SHOW_TIMELINE_RAIL = readBooleanSetting('SHOW_TIMELINE_RAIL', false);
const SHOW_ATTACHMENTS = readBooleanSetting('SHOW_ATTACHMENTS', true);
// Links are looked up for the whole page of records, and a record can carry
// several — so they get a wider budget than the page itself.
const LINK_PAGE_SIZE = Math.min(PAGE_SIZE * 4, 200);

// An import or a bulk edit produces the same event on dozens of records at
// once. One row per record buries everything else, so a burst of identical
// events by one person collapses into a single line.
const BULK_THRESHOLD = 5;
const BULK_WINDOW_MS = 5 * 60 * 1000;

const DEFAULT_SCOPE = readSetting('DEFAULT_SCOPE') === 'all' ? 'all' : 'mine';

// The read-state object is written by this very panel, so its own events would
// otherwise show up in the feed as noise about the feed.
const HIDDEN_EVENT_PREFIX = 'feedReadState.';

const ACTION_LABELS = {
  created: msg('created'),
  updated: msg('updated'),
  deleted: msg('deleted'),
} as const;

// Russian overrides for the standard objects; everything else (including every
// custom object) takes its label from the workspace's own object metadata.
const OBJECT_LABELS = {
  person: msg('Person'),
  company: msg('Company'),
  opportunity: msg('Opportunity'),
  task: msg('Task'),
  note: msg('Note'),
} as const;

// Attaching a note or a task to a record emits `linked-<kind>.<action>`, whose
// target is the record and whose `linkedRecordCachedName` is the note title.
// This is how comments on a record surface in the timeline.
const LINKED_KIND_LABELS = {
  note: msg('comment'),
  task: msg('task'),
  attachment: msg('document'),
} as const;

const LINKED_ACTION_LABELS = {
  created: msg('added'),
  updated: msg('edited'),
  deleted: msg('removed'),
} as const;

// Twenty's own palette (twenty-ui/theme MAIN_COLORS_LIGHT, converted from
// display-p3), matched to the colours the sidebar already gives each object.
// Object metadata carries no colour field, so this mapping is the only way to
// agree with what the app renders.
const OBJECT_COLORS: Record<string, string> = {
  company: '#4662D5', // blue
  person: '#5B5BCF', // iris
  opportunity: '#D45453', // red
  task: '#55A271', // green
  note: '#51A185', // jade
};

// twenty-ui MAIN_COLORS_LIGHT, converted from display-p3. SELECT options in
// field metadata reference these by name.
const ACCENT_BLUE = '#4662D5';

const THEME_COLORS: Record<string, string> = {
  red: '#D45453',
  ruby: '#D45268',
  crimson: '#D74C81',
  tomato: '#D4583B',
  orange: '#E67333',
  amber: '#FFC442',
  yellow: '#FFEB38',
  lime: '#C7ED77',
  grass: '#61A560',
  green: '#55A271',
  jade: '#51A185',
  mint: '#9EE8D5',
  turquoise: '#4CA294',
  cyan: '#48A0C3',
  sky: '#95E0FB',
  blue: '#4662D5',
  iris: '#5B5BCF',
  violet: '#6A57C8',
  purple: '#8551C0',
  plum: '#9F50B5',
  pink: '#C64C9C',
  bronze: '#9C8174',
  gold: '#948469',
  brown: '#A6815E',
  gray: '#999999',
};

// Custom objects (dostavki, reklamacii, …) get a stable colour from this
// fallback ring, keyed by the object name so it never shifts between rows.
// Deliberately none of the colours used by the standard objects above.
const FALLBACK_OBJECT_COLORS = [
  '#E67333', // orange
  '#8551C0', // purple
  '#C64C9C', // pink
  '#4CA294', // turquoise
  '#FFEB38', // yellow
];

type TimelineRecord = Record<string, unknown>;

type FeedGroup = { key: string; items: TimelineRecord[] };

// REST answers with the rows plus how many there are in total and where the
// page ended — that is what makes "loaded 96 of 199" and paging possible.
type Page<K extends string> = {
  data?: Partial<Record<K, TimelineRecord[]>>;
  totalCount?: number;
  pageInfo?: { endCursor?: string; hasNextPage?: boolean };
};

// The server's cursor is nothing but the sort key of the last row, base64'd —
// verified byte-for-byte against `pageInfo.endCursor`. Building it from the
// oldest row we already hold means paging never depends on a `pageInfo` that
// may not survive a poll, and it repairs itself after any refresh.
const cursorFor = (item: TimelineRecord) =>
  btoa(JSON.stringify({ happensAt: item.happensAt, id: item.id }));

const isVisibleEvent = (item: TimelineRecord) =>
  typeof item.name !== 'string' || !item.name.startsWith(HIDDEN_EVENT_PREFIX);

type FieldMeta = {
  label: string;
  options?: Record<string, { label: string; color: string }>;
};

type ResolvedTarget = {
  objectNameSingular: string;
  recordId: string;
  label: string;
  avatarUrl?: string;
};

const readDisplayName = (record: unknown): string => {
  if (record === null || typeof record !== 'object') {
    return '';
  }

  const { name, title } = record as { name?: unknown; title?: unknown };

  if (typeof name === 'string') {
    return name;
  }

  if (name !== null && typeof name === 'object') {
    const { firstName, lastName } = name as {
      firstName?: string;
      lastName?: string;
    };

    return [firstName, lastName].filter(Boolean).join(' ');
  }

  return typeof title === 'string' ? title : '';
};

const readMemberId = (value: unknown): string | undefined => {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }

  const { workspaceMemberId, id } = value as {
    workspaceMemberId?: unknown;
    id?: unknown;
  };

  if (typeof workspaceMemberId === 'string' && workspaceMemberId !== '') {
    return workspaceMemberId;
  }

  return typeof id === 'string' && id !== '' ? id : undefined;
};

const readAvatarUrl = (record: unknown): string | undefined => {
  if (record === null || typeof record !== 'object') {
    return undefined;
  }

  const { avatarUrl } = record as { avatarUrl?: unknown };

  return typeof avatarUrl === 'string' && avatarUrl !== '' ? avatarUrl : undefined;
};

// Both the object type and the record id come from whichever `target<Object>Id`
// is filled in — deliberately not from the event name. `linked-note.created`
// carries `targetCompanyId`, so trusting the event name would build the route
// /object/linked-note/<company id>. Reading the raw REST payload also makes
// custom objects — dostavki, reklamacii — resolvable without naming them.
const resolveTarget = (item: TimelineRecord): ResolvedTarget | null => {
  const idEntry = Object.entries(item).find(
    ([key, value]) =>
      key.startsWith('target') &&
      key.endsWith('Id') &&
      typeof value === 'string' &&
      value !== '',
  );

  if (idEntry === undefined) {
    return null;
  }

  const relationKey = idEntry[0].slice(0, -2);
  const bare = relationKey.slice('target'.length);

  return {
    objectNameSingular: bare.charAt(0).toLowerCase() + bare.slice(1),
    recordId: idEntry[1] as string,
    label: readDisplayName(item[relationKey]),
    avatarUrl: readAvatarUrl(item[relationKey]),
  };
};

const ATTACHMENT_EVENT = 'linked-attachment.created';

// Attaching a file emits no timeline event at all — verified against a live
// instance. Attachments carry their own `target<Object>Id` and `createdAt`,
// so they are read separately and folded into the feed as synthetic events.
const toAttachmentEvent = (attachment: TimelineRecord): TimelineRecord => ({
  ...attachment,
  id: `attachment-${String(attachment.id)}`,
  name: ATTACHMENT_EVENT,
  happensAt: attachment.createdAt,
  linkedRecordCachedName: attachment.name,
  properties: null,
});

const GOOGLE_DRIVE_HOSTS = ['drive.google.com', 'docs.google.com'];

// One glyph for every format. Per-extension icons turned the strip into a
// sticker sheet, and Twenty's own pack has no per-format family anyway — a
// link is the only thing worth telling apart, because it is not a file.
const getFileIcon = (fileName: string) => {
  const name = fileName.toLowerCase();

  if (!name.startsWith('http')) {
    return IconFile;
  }

  return GOOGLE_DRIVE_HOSTS.some((host) => name.includes(host))
    ? IconBrandGoogle
    : IconLink;
};

const readMarkdown = (body: unknown) => {
  if (body === null || typeof body !== 'object') {
    return '';
  }

  const { markdown } = body as { markdown?: unknown };

  return typeof markdown === 'string' ? markdown : '';
};

// An edit either appends to the note (a comment) or rewrites it. Only the
// appended part is worth showing — that is the thing that was actually said.
const readNoteEdit = (event: TimelineRecord) => {
  const diff = (
    event.properties as { diff?: { bodyV2?: { before?: unknown; after?: unknown } } } | null
  )?.diff?.bodyV2;

  const before = readMarkdown(diff?.before);
  const after = readMarkdown(diff?.after);

  if (after !== '' && after.startsWith(before)) {
    return { text: after.slice(before.length).trim(), isRewrite: false, before };
  }

  return { text: after.trim(), isRewrite: true, before };
};

// The note as it stood when the comment was written: its last paragraphs.
// `before` is the exact body at that moment, so the context is reconstructed
// precisely rather than guessed from the current text.
const readContextBefore = (before: string, paragraphs = 2) => {
  const blocks = before
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== '');

  return blocks.slice(-paragraphs);
};

const isRichTextValue = (value: unknown) =>
  value !== null && typeof value === 'object' && 'markdown' in value;

const truncate = (text: string, limit = 90) =>
  text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;

// A rich-text diff is two whole documents. Neither is worth printing in a feed
// row — what changed is.
const describeRichTextChange = (beforeRaw: unknown, afterRaw: unknown) => {
  const before = readMarkdown(beforeRaw);
  const after = readMarkdown(afterRaw);

  if (before === after) {
    return t('no change');
  }

  if (before === '') {
    return t('text added: {text}', { text: truncate(after) });
  }

  if (after === '') {
    return t('text removed');
  }

  if (after.startsWith(before)) {
    return t('appended: {text}', { text: truncate(after.slice(before.length).trim()) });
  }

  if (before.startsWith(after)) {
    return t('text shortened');
  }

  return t('rewritten: {text}', { text: truncate(after) });
};

const byHappensAtDesc = (a: TimelineRecord, b: TimelineRecord) =>
  new Date(String(b.happensAt)).getTime() -
  new Date(String(a.happensAt)).getTime();

// Diff values arrive as raw column payloads: plain scalars, composites
// (FULL_NAME, CURRENCY, ACTOR) and relations reduced to { id }. Dumping JSON
// at the user is not an option.
// Raw ISO timestamps are unreadable in a diff line. When the value carries no
// meaningful time of day, the date alone is enough.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

const formatDateValue = (value: string) => {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const stamp = `${day}.${month}.${date.getFullYear()}`;

  if (date.getHours() === 0 && date.getMinutes() === 0) {
    return stamp;
  }

  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${stamp}, ${hours}:${minutes}`;
};

const formatValue = (
  value: unknown,
  memberNames: Record<string, string>,
): string => {
  if (value === null || value === undefined || value === '') {
    return '—';
  }

  if (typeof value === 'string' && ISO_DATE.test(value)) {
    return formatDateValue(value);
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  const record = value as Record<string, unknown>;

  // ACTOR — createdBy / updatedBy and friends.
  if (typeof record.name === 'string' && record.name !== '') {
    return record.name;
  }

  // FULL_NAME
  const composedName = [record.firstName, record.lastName]
    .filter((part) => typeof part === 'string' && part !== '')
    .join(' ');

  if (composedName !== '') {
    return composedName;
  }

  // CURRENCY
  if (typeof record.amountMicros === 'number') {
    const amount = record.amountMicros / 1_000_000;

    return `${amount} ${String(record.currencyCode ?? '')}`.trim();
  }

  // LINKS / EMAILS / PHONES keep the primary value up front.
  const primary =
    record.primaryLinkUrl ?? record.primaryEmail ?? record.primaryPhoneNumber;

  if (typeof primary === 'string' && primary !== '') {
    return primary;
  }

  // A relation, reduced to its id — resolvable when it points at a teammate.
  if (typeof record.id === 'string') {
    return memberNames[record.id] ?? '—';
  }

  return '—';
};

// Bookkeeping fields change on every single write, so their diffs are noise.
const HIDDEN_DIFF_FIELDS = [
  'updatedBy',
  'createdBy',
  'updatedAt',
  'createdAt',
  'deletedAt',
  'position',
  'searchVector',
];

// properties is RAW_JSON — the server puts a { diff: { field: { before, after } } }
// payload there on `updated` events, and an empty object on `created`.
const extractDiff = (properties: unknown) => {
  const diff = (properties as { diff?: Record<string, unknown> } | null)?.diff;

  if (!diff || typeof diff !== 'object') {
    return [];
  }

  return Object.entries(diff)
    .filter(([field]) => !HIDDEN_DIFF_FIELDS.includes(field))
    .map(([field, change]) => {
      const { before, after } = (change ?? {}) as {
        before?: unknown;
        after?: unknown;
      };

      return { field, beforeRaw: before, afterRaw: after };
    });
};

const formatAgo = (isoDate: string) => {
  const minutes = Math.floor((Date.now() - new Date(isoDate).getTime()) / 60_000);

  if (minutes < 1) {
    return t('just now');
  }

  if (minutes < 60) {
    return t('{minutes}m', { minutes });
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return t('{hours}h', { hours });
  }

  return t('{days}d', { days: Math.floor(hours / 24) });
};

const DAY_MS = 24 * 60 * 60 * 1000;

const describeDue = (dueAt: unknown) => {
  if (typeof dueAt !== 'string' || dueAt === '') {
    return { label: t('no due date'), overdueDays: 0, sortKey: Number.MAX_SAFE_INTEGER };
  }

  const due = new Date(dueAt).getTime();
  const days = Math.floor((Date.now() - due) / DAY_MS);

  if (days > 0) {
    return {
      label: t('{days}d overdue', { days }),
      overdueDays: days,
      sortKey: due,
    };
  }

  if (days === 0) {
    return { label: t('today'), overdueDays: 0, sortKey: due };
  }

  return { label: t('in {days}d', { days: -days }), overdueDays: 0, sortKey: due };
};

const getObjectColor = (objectNameSingular: string) => {
  const known = OBJECT_COLORS[objectNameSingular];

  if (known !== undefined) {
    return known;
  }

  let hash = 0;

  for (let index = 0; index < objectNameSingular.length; index++) {
    hash = (hash * 31 + objectNameSingular.charCodeAt(index)) % 100_000;
  }

  return FALLBACK_OBJECT_COLORS[hash % FALLBACK_OBJECT_COLORS.length];
};

const getInitials = (value: string) =>
  value
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

const getPalette = (colorScheme: 'light' | 'dark') =>
  colorScheme === 'dark'
    ? {
        text: '#E8E8E8',
        textMid: '#A8A8A8',
        textLight: '#7E7E7E',
        border: '#282828',
        rail: '#333333',
        hover: '#1F1F1F',
        buttonBackground: 'rgba(255, 255, 255, 0.06)',
        // A card under the cursor is marked by its outline alone — the fill
        // stays flat so the feed does not flicker as the pointer crosses it.
        cardHoverBorder: 'rgba(149, 224, 251, 0.24)',
        mutedFill: '#3A3A3A',
        mutedGlyph: '#8F8F8F',
      }
    : {
        // twenty-ui FONT_LIGHT tokens: primary / secondary / tertiary.
        text: '#333333',
        textMid: '#666666',
        textLight: '#999999',
        border: '#EDEDED',
        rail: '#E3E3E3',
        hover: '#0000000A',
        buttonBackground: 'rgba(0, 0, 0, 0.035)',
        cardHoverBorder: 'rgba(70, 98, 213, 0.26)',
        mutedFill: '#F0F0F0',
        mutedGlyph: '#999999',
      };

const InlineAvatar = ({
  label,
  color,
  textColor,
  avatarUrl,
  size,
}: {
  label: string;
  color: string;
  textColor: string;
  avatarUrl?: string;
  size: number;
}) => {
  if (avatarUrl !== undefined) {
    return (
      <img
        src={avatarUrl}
        alt=""
        style={{
          width: `${size}px`,
          height: `${size}px`,
          borderRadius: '3px',
          objectFit: 'cover',
          flexShrink: 0,
        }}
      />
    );
  }

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: '3px',
        background: color,
        color: textColor,
        fontSize: `${Math.round(size * 0.5)}px`,
        fontWeight: 500,
        flexShrink: 0,
      }}
    >
      {getInitials(label) || '?'}
    </span>
  );
};

const ToolbarButton = ({
  label,
  title,
  onClick,
  background,
  color,
  isActive,
  activeColor,
}: {
  label: string;
  title?: string;
  onClick: () => void;
  background: string;
  color: string;
  isActive?: boolean;
  activeColor?: string;
}) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    aria-pressed={isActive}
    style={{
      padding: '4px 9px',
      borderRadius: '4px',
      whiteSpace: 'nowrap',
      flexShrink: 0,
      border:
        isActive === true
          ? `1px solid ${activeColor ?? color}`
          : '1px solid transparent',
      background: isActive === true ? 'transparent' : background,
      color: isActive === true ? (activeColor ?? color) : color,
      fontSize: '0.85rem',
      fontWeight: isActive === true ? 500 : 400,
      cursor: 'pointer',
      fontFamily: 'inherit',
    }}
  >
    {label}
  </button>
);

const ActivityFeed = () => {
  const colorScheme = useColorScheme();
  const palette = getPalette(colorScheme);
  const userId = useUserId();

  const [items, setItems] = useState<TimelineRecord[]>([]);
  const [objectLabels, setObjectLabels] = useState<Record<string, string>>({});
  const [fieldMeta, setFieldMeta] = useState<Record<string, FieldMeta>>({});
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [expandedComments, setExpandedComments] = useState<string[]>([]);
  const [expandedThreads, setExpandedThreads] = useState<string[]>([]);
  // Cards keep their own hover state: the inner rows and comments share
  // `hoveredId`, and their onMouseLeave would otherwise clear the card's
  // highlight while the cursor is still inside it.
  const [hoveredCard, setHoveredCard] = useState<string | null>(null);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [myCompanyIds, setMyCompanyIds] = useState<string[]>([]);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [memberAvatars, setMemberAvatars] = useState<Record<string, string>>({});
  const [scope, setScope] = useState<'mine' | 'all'>(DEFAULT_SCOPE);
  const [enforcement, setEnforcement] = useState<
    'server' | 'client' | 'unknown'
  >('unknown');
  const [view, setView] = useState<'feed' | 'tasks' | 'buzz'>('feed');
  const [tasks, setTasks] = useState<TimelineRecord[]>([]);
  const [notes, setNotes] = useState<TimelineRecord[]>([]);
  const [noteEdits, setNoteEdits] = useState<TimelineRecord[]>([]);
  const [noteTargets, setNoteTargets] = useState<TimelineRecord[]>([]);
  const [taskEdits, setTaskEdits] = useState<TimelineRecord[]>([]);
  const [taskTargets, setTaskTargets] = useState<TimelineRecord[]>([]);
  const [lastSeenAt, setLastSeenAt] = useState<string | null>(null);
  const [readStateId, setReadStateId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [feedTotal, setFeedTotal] = useState(0);
  // Pages fetched behind the first one. Kept apart from `items` so the poll can
  // refresh the newest page without throwing away what the reader paged in.
  const [olderItems, setOlderItems] = useState<TimelineRecord[]>([]);
  const [isFeedExhausted, setIsFeedExhausted] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  // Files are refreshed with the links rather than on every poll: a hundred
  // attachments at depth 1 is a quarter-megabyte of JSON, and a document that
  // appears half a minute later is nobody's emergency.
  const [documentItems, setDocumentItems] = useState<TimelineRecord[]>([]);
  // A file filed under a contact says nothing about the business behind it, so
  // the card borrows context: the contact's company, and that company's live
  // deal. Kept as flat maps because that is all the chips need.
  const [companyNames, setCompanyNames] = useState<Record<string, string>>({});
  const [companyDeals, setCompanyDeals] = useState<
    Record<string, { id: string; name: string }>
  >({});

  const loadFeed = useCallback(async () => {
    try {
      const client = new RestApiClient();

      const timeline = await client.get<Page<'timelineActivities'>>(
        '/rest/timelineActivities',
        {
          query: {
            limit: PAGE_SIZE,
            depth: 1,
            order_by: 'happensAt[DescNullsLast]',
          },
        },
      );

      setItems(
        (timeline.data?.timelineActivities ?? []).filter(isVisibleEvent),
      );
      setFeedTotal(timeline.totalCount ?? 0);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsLoading(false);
    }
  }, []);

  // One page further back, never past the cap. Files do not page: they live in
  // their own strip with its own expander.
  const loadMore = async () => {
    const oldest = loadedEvents[loadedEvents.length - 1];

    if (oldest === undefined || loadedEvents.length >= FEED_LIMIT) {
      return;
    }

    setIsLoadingMore(true);

    try {
      const page = await new RestApiClient().get<Page<'timelineActivities'>>(
        '/rest/timelineActivities',
        {
          query: {
            // A whole page every time. Trimming the request to the remaining
            // room made the last clicks add one or two rows each; the hard cap
            // on `changes` does the trimming instead.
            limit: PAGE_SIZE,
            depth: 1,
            order_by: 'happensAt[DescNullsLast]',
            starting_after: cursorFor(oldest),
          },
        },
      );

      const fetched = (page.data?.timelineActivities ?? []).filter(isVisibleEvent);

      setIsFeedExhausted(fetched.length === 0);
      setOlderItems((prev) => [...prev, ...fetched]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsLoadingMore(false);
    }
  };

  // Custom objects should read by their own label, not their API name —
  // own metadata is the only place those labels exist.
  const loadObjectLabels = useCallback(async () => {
    try {
      const client = new RestApiClient();

      const response = await client.get<{
        data?: {
          objects?: {
            nameSingular: string;
            labelSingular: string;
            fields?: {
              name: string;
              label: string;
              options?: { value: string; label: string; color: string }[];
            }[];
          }[];
        };
      }>('/rest/metadata/objects', { query: { limit: 200 } });

      const objects = response.data?.objects ?? [];

      setObjectLabels(
        Object.fromEntries(
          objects.map((object) => [object.nameSingular, object.labelSingular]),
        ),
      );

      // SELECT options come with their own label and theme colour, which is
      // what turns `stage: NEW → MEETING` into the labels the record shows.
      setFieldMeta(
        Object.fromEntries(
          objects.flatMap((object) =>
            (object.fields ?? []).map((field) => [
              `${object.nameSingular}.${field.name}`,
              {
                label: field.label,
                options:
                  field.options === undefined
                    ? undefined
                    : Object.fromEntries(
                        field.options.map((option) => [
                          option.value,
                          { label: option.label, color: option.color },
                        ]),
                      ),
              },
            ]),
          ),
        ),
      );
    } catch {
      // Without labels the feed falls back to raw object names.
    }
  }, []);

  // Who is looking. The app token carries the application's role, not the
  // viewer's, so the panel has to work out relevance itself.
  const loadViewer = useCallback(async () => {
    if (userId === null) {
      return;
    }

    try {
      const client = new RestApiClient();

      const members = await client.get<{
        data?: {
          workspaceMembers?: {
            id: string;
            userId?: string;
            name?: { firstName?: string; lastName?: string };
            avatarUrl?: string;
          }[];
        };
      }>('/rest/workspaceMembers', { query: { limit: 200 } });

      const allMembers = members.data?.workspaceMembers ?? [];

      setMemberNames(
        Object.fromEntries(
          allMembers.map((member) => [
            member.id,
            [member.name?.firstName, member.name?.lastName]
              .filter(Boolean)
              .join(' '),
          ]),
        ),
      );

      setMemberAvatars(
        Object.fromEntries(
          allMembers
            .filter((member) => (member.avatarUrl ?? '') !== '')
            .map((member) => [member.id, member.avatarUrl as string]),
        ),
      );

      const id =
        allMembers.find((member) => member.userId === userId)?.id ?? null;

      setMemberId(id);

      if (id === null) {
        return;
      }

      const companies = await client.get<{
        data?: { companies?: { id: string }[] };
      }>('/rest/companies', {
        query: { filter: `accountOwnerId[eq]:${id}`, limit: 200 },
      });

      setMyCompanyIds((companies.data?.companies ?? []).map((c) => c.id));

      // Is row-level security actually enforced? Row-level permissions are an
      // Organization-plan feature, so the same build lands on instances where
      // the predicates in our role are live and on ones where they are inert.
      // Rather than guess the plan, ask the server for records it should have
      // withheld: if a deal owned by somebody else comes back, enforcement is
      // off and the panel has to filter by itself.
      const probe = await client.get<{
        data?: { opportunities?: { ownerId?: string | null }[] };
      }>('/rest/opportunities', { query: { limit: 100 } });

      const owned = (probe.data?.opportunities ?? []).filter(
        (row) => typeof row.ownerId === 'string' && row.ownerId !== '',
      );
      const foreign = owned.filter((row) => row.ownerId !== id);

      setEnforcement(
        foreign.length > 0 ? 'client' : owned.length > 0 ? 'server' : 'unknown',
      );
    } catch {
      // Without a resolved member the panel falls back to showing everything.
    }
  }, [userId]);

  // What a task or a note hangs on — a deal, a company, a contact. The to-many
  // link is not expanded on the record itself, so it is read separately.
  //
  // Only for the records actually on screen. Reading the two hundred newest
  // links blind cost 700 KB per call and kept every one of them alive in
  // memory; asking by id costs a few kilobytes and returns exactly what the
  // chips need.
  const loadLinks = useCallback(async (taskIds: string[], noteIds: string[]) => {
    try {
      const client = new RestApiClient();

      const [taskResponse, noteResponse] = await Promise.all([
        taskIds.length === 0
          ? Promise.resolve({ data: { taskTargets: [] } })
          : client.get<{ data?: { taskTargets?: TimelineRecord[] } }>(
              '/rest/taskTargets',
              {
                query: {
                  filter: `taskId[in]:[${taskIds.join(',')}]`,
                  limit: LINK_PAGE_SIZE,
                  depth: 1,
                },
              },
            ),
        noteIds.length === 0
          ? Promise.resolve({ data: { noteTargets: [] } })
          : client.get<{ data?: { noteTargets?: TimelineRecord[] } }>(
              '/rest/noteTargets',
              {
                query: {
                  filter: `noteId[in]:[${noteIds.join(',')}]`,
                  limit: LINK_PAGE_SIZE,
                },
              },
            ),
      ]);

      setTaskTargets(taskResponse.data?.taskTargets ?? []);
      setNoteTargets(noteResponse.data?.noteTargets ?? []);
    } catch {
      // Missing links only cost the chips, so a failure here stays silent.
    }
  }, []);

  // Two lookups by id, the same shape as the links: whatever is on screen, and
  // nothing more. A closed deal is skipped — the point is what is live now.
  const loadContext = useCallback(async (companyIds: string[]) => {
    if (companyIds.length === 0) {
      setCompanyNames({});
      setCompanyDeals({});

      return;
    }

    try {
      const client = new RestApiClient();
      const filter = `id[in]:[${companyIds.join(',')}]`;

      const [companies, deals] = await Promise.all([
        client.get<{ data?: { companies?: TimelineRecord[] } }>(
          '/rest/companies',
          { query: { filter, limit: LINK_PAGE_SIZE, depth: 0 } },
        ),
        client.get<{ data?: { opportunities?: TimelineRecord[] } }>(
          '/rest/opportunities',
          {
            query: {
              filter: `companyId[in]:[${companyIds.join(',')}]`,
              limit: LINK_PAGE_SIZE,
              depth: 0,
              order_by: 'createdAt[DescNullsLast]',
            },
          },
        ),
      ]);

      setCompanyNames(
        Object.fromEntries(
          (companies.data?.companies ?? []).map((company) => [
            String(company.id),
            typeof company.name === 'string' ? company.name : '',
          ]),
        ),
      );

      const live: Record<string, { id: string; name: string }> = {};

      for (const deal of deals.data?.opportunities ?? []) {
        const companyId = String(deal.companyId ?? '');
        const stage = String(deal.stage ?? '');

        if (
          companyId === '' ||
          live[companyId] !== undefined ||
          stage === 'WON' ||
          stage === 'LOST'
        ) {
          continue;
        }

        live[companyId] = {
          id: String(deal.id),
          name: typeof deal.name === 'string' ? deal.name : '',
        };
      }

      setCompanyDeals(live);
    } catch {
      // No context is a missing chip, never a broken card.
    }
  }, []);

  const loadDocuments = useCallback(async () => {
    if (!SHOW_ATTACHMENTS) {
      return;
    }

    try {
      const response = await new RestApiClient().get<{
        data?: { attachments?: TimelineRecord[] };
      }>('/rest/attachments', {
        // At fifty the newest files were all on contacts and companies, and
        // documents filed under tasks or notes never showed up.
        query: {
          limit: FEED_LIMIT,
          depth: 1,
          order_by: 'createdAt[DescNullsLast]',
        },
      });

      setDocumentItems(
        (response.data?.attachments ?? []).map(toAttachmentEvent),
      );
    } catch {
      // The strip stays empty; the change feed is unaffected.
    }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const client = new RestApiClient();

      const [response, editsResponse] = await Promise.all([
        client.get<{ data?: { tasks?: TimelineRecord[] } }>('/rest/tasks', {
          query: {
            limit: PAGE_SIZE,
            depth: 1,
            order_by: 'dueAt[AscNullsLast]',
          },
        }),
        // A task body can be amended exactly like a note body, which is the
        // only comment mechanism a task has — notes cannot be linked to tasks.
        client.get<{ data?: { timelineActivities?: TimelineRecord[] } }>(
          '/rest/timelineActivities',
          {
            query: {
              filter: 'name[eq]:task.updated',
              limit: PAGE_SIZE,
              depth: 1,
              order_by: 'happensAt[AscNullsLast]',
            },
          },
        ),
      ]);

      setTasks(response.data?.tasks ?? []);
      setTaskEdits(editsResponse.data?.timelineActivities ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  // Buzz: notes as posts, and every later edit of a note body as a comment.
  // Twenty has no comment object — amending the note text is the mechanism —
  // so the thread is reconstructed from `note.updated` diffs.
  const loadBuzz = useCallback(async () => {
    try {
      const client = new RestApiClient();

      const [notesResponse, editsResponse] = await Promise.all([
        client.get<{ data?: { notes?: TimelineRecord[] } }>('/rest/notes', {
          query: {
            limit: PAGE_SIZE,
            depth: 1,
            order_by: 'createdAt[DescNullsLast]',
          },
        }),
        client.get<{ data?: { timelineActivities?: TimelineRecord[] } }>(
          '/rest/timelineActivities',
          {
            query: {
              filter: 'name[eq]:note.updated',
              limit: PAGE_SIZE,
              depth: 1,
              order_by: 'happensAt[AscNullsLast]',
            },
          },
        ),
      ]);

      setNotes(notesResponse.data?.notes ?? []);
      setNoteEdits(editsResponse.data?.timelineActivities ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  const loadReadState = useCallback(async () => {
    if (userId === null) {
      return;
    }

    try {
      const client = new RestApiClient();

      const response = await client.get<{
        data?: { feedReadStates?: { id: string; lastSeenAt?: string }[] };
      }>('/rest/feedReadStates', {
        query: { filter: `userId[eq]:${userId}`, limit: 1 },
      });

      const state = response.data?.feedReadStates?.[0];

      setReadStateId(state?.id ?? null);
      setLastSeenAt(state?.lastSeenAt ?? null);
    } catch {
      // A missing read state just means everything reads as unread.
    }
  }, [userId]);

  useEffect(() => {
    void loadReadState();
    void loadObjectLabels();
    void loadViewer();
  }, [loadReadState, loadObjectLabels, loadViewer]);

  // Files change rarely, so they ride the tab switch rather than the poll.
  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments, view]);

  // Only the tab in front of the user is polled. Refreshing all three every
  // 15 seconds meant 1.7 MB of JSON per cycle — most of it for screens nobody
  // was looking at, all of it parsed into objects the sandbox then collected.
  useEffect(() => {
    const refresh = () => {
      if (view === 'tasks') {
        void loadTasks();
      } else if (view === 'buzz') {
        void loadBuzz();
      } else {
        void loadFeed();
      }
    };

    refresh();

    const intervalId = setInterval(refresh, POLL_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [view, loadFeed, loadTasks, loadBuzz]);

  const markAllAsRead = async () => {
    if (userId === null) {
      return;
    }

    const now = new Date().toISOString();
    const client = new RestApiClient();

    setLastSeenAt(now);

    if (readStateId !== null) {
      await client.patch(`/rest/feedReadStates/${readStateId}`, {
        lastSeenAt: now,
      });

      return;
    }

    const created = await client.post<{
      data?: { createFeedReadState?: { id: string } };
    }>('/rest/feedReadStates', { userId, lastSeenAt: now });

    setReadStateId(created.data?.createFeedReadState?.id ?? null);
  };

  // The SDK cannot scroll to a position inside a record — no anchor, offset or
  // block id anywhere in the front-component API. EditRichText is the closest
  // thing: it opens the note's body instead of the record overview, and since
  // comments are appended the newest text sits at the end of it.
  const openNoteBody = (noteId: string) => {
    void openSidePanelPage({
      page: SidePanelPages.EditRichText,
      recordId: noteId,
      objectNameSingular: 'note',
      fieldName: 'bodyV2',
    });
  };

  const openRecord = (target: ResolvedTarget) => {
    void openSidePanelPage({
      page: SidePanelPages.ViewRecord,
      recordId: target.recordId,
      objectNameSingular: target.objectNameSingular,
    });
  };

  const isUnread = (item: TimelineRecord) =>
    lastSeenAt === null ||
    new Date(String(item.happensAt)).getTime() > new Date(lastSeenAt).getTime();

  // Relevance, not security: this decides what is worth showing, it does not
  // stop the data reaching the browser. The app role is what actually governs
  // access, and it is workspace-wide.
  const isMine = (item: TimelineRecord) => {
    if (memberId === null) {
      return true;
    }

    if (item.workspaceMemberId === memberId) {
      return true;
    }

    const relationKey = Object.keys(item).find(
      (key) =>
        key.startsWith('target') && !key.endsWith('Id') && item[key] !== null,
    );
    const record = relationKey === undefined ? null : item[relationKey];

    if (record === null || typeof record !== 'object') {
      return false;
    }

    const { ownerId, accountOwnerId, assigneeId, companyId, id } =
      record as Record<string, unknown>;

    if (
      ownerId === memberId ||
      accountOwnerId === memberId ||
      assigneeId === memberId
    ) {
      return true;
    }

    if (typeof companyId === 'string' && myCompanyIds.includes(companyId)) {
      return true;
    }

    return typeof id === 'string' && myCompanyIds.includes(id);
  };

  // The newest page plus everything paged in behind it. Keyed by id: a poll can
  // land mid-scroll and serve the same event twice. Memoised because hovering a
  // card is a state change, and re-sorting on every mouse move is work nobody
  // asked for.
  const allItems = useMemo(
    () =>
      [
        ...new Map(
          [...items, ...olderItems, ...documentItems].map((item) => [
            String(item.id),
            item,
          ]),
        ).values(),
      ].sort(byHappensAtDesc),
    [items, olderItems, documentItems],
  );

  // On an enforcing instance the server already scoped the response, so
  // filtering again would only hide records the viewer is entitled to.
  const visibleItems = useMemo(
    () =>
      enforcement !== 'server' && scope === 'mine'
        ? allItems.filter(isMine)
        : allItems,
    // `isMine` is rebuilt every render; what it actually reads is listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allItems, enforcement, scope, memberId, myCompanyIds],
  );

  // Tasks view: what is hanging, not what changed. Done tasks are dropped —
  // a finished task is never something the user still owes.
  const openTasks = tasks.filter((task) => {
    if (task.status === 'DONE') {
      return false;
    }

    if (enforcement === 'server' || scope === 'all' || memberId === null) {
      return true;
    }

    return task.assigneeId === memberId;
  });

  const overdueTasks = openTasks
    .filter((task) => describeDue(task.dueAt).overdueDays > 0)
    .sort((a, b) => describeDue(a.dueAt).sortKey - describeDue(b.dueAt).sortKey);

  const upcomingTasks = openTasks
    .filter((task) => describeDue(task.dueAt).overdueDays === 0)
    .sort((a, b) => describeDue(a.dueAt).sortKey - describeDue(b.dueAt).sortKey);

  // A post keeps the text the note started with; everything appended later
  // becomes a comment under it.
  // A note that hangs on a deal belongs to that deal's story, not to the
  // team wall — Buzz keeps everything else.
  const noteIdsOnDeals = new Set(
    noteTargets
      .filter((link) => typeof link.targetOpportunityId === 'string')
      .map((link) => String(link.noteId)),
  );

  const buzzPosts = notes
    .filter((note) => !noteIdsOnDeals.has(String(note.id)))
    .map((note) => {
      const edits = noteEdits.filter(
        (edit) => edit.targetNoteId === note.id,
      );
      const comments = edits
        .map((edit) => ({ edit, parsed: readNoteEdit(edit) }))
        .filter(({ parsed }) => parsed.text !== '');

      const originalBody =
        comments.length > 0
          ? comments[0].parsed.before
          : readMarkdown(note.bodyV2);

      return { note, comments, originalBody };
    })
    .filter(
      (post) =>
        post.comments.length > 0 ||
        post.originalBody !== '' ||
        typeof post.note.title === 'string',
    );

  // Several events on the same record collapse into one row: the newest is
  // shown, the rest hide behind a counter.
  const describeBulk = (item: TimelineRecord) => {
    const [subject = '', action = ''] = String(item.name ?? '').split('.');
    const target = resolveTarget(item);

    return {
      // The event subject has to stay in the key. A file attached to a deal and
      // the deal itself both resolve to `opportunity`, so without it a batch of
      // uploads merged into the deals row and was counted as deals.
      subject,
      objectNameSingular: target?.objectNameSingular ?? subject,
      action,
      author: String(
        item.workspaceMemberId ?? readMemberId(item.createdBy) ?? '',
      ),
      bucket: Math.floor(
        new Date(String(item.happensAt)).getTime() / BULK_WINDOW_MS,
      ),
    };
  };

  type FeedEntry =
    | { kind: 'group'; key: string; items: TimelineRecord[] }
    | { kind: 'bulk'; key: string; items: TimelineRecord[] };

  // Grouping walks the whole feed twice and sorts the result. It depends on
  // the events alone, so it is rebuilt when they change — not when a card
  // lights up under the cursor.
  // Every change event fetched, before the personal filter. This is what the
  // counter compares against the server's total and what paging walks back
  // from — the filtered list would page into a different place.
  const loadedEvents = useMemo(
    () => allItems.filter((item) => item.name !== ATTACHMENT_EVENT),
    [allItems],
  );

  // Which records the chips will actually be asked about. The signature keeps
  // the effect from refiring when the same set comes back in another order.
  const linkedIds = useMemo(() => {
    const taskIds = new Set<string>();
    const noteIds = new Set<string>();

    for (const item of allItems) {
      if (typeof item.targetTaskId === 'string' && item.targetTaskId !== '') {
        taskIds.add(item.targetTaskId);
      }

      if (typeof item.targetNoteId === 'string' && item.targetNoteId !== '') {
        noteIds.add(item.targetNoteId);
      }
    }

    for (const task of tasks) {
      taskIds.add(String(task.id));
    }

    for (const note of notes) {
      noteIds.add(String(note.id));
    }

    return { taskIds: [...taskIds].sort(), noteIds: [...noteIds].sort() };
  }, [allItems, tasks, notes]);

  const linkSignature = `${linkedIds.taskIds.join(',')}|${linkedIds.noteIds.join(',')}`;

  useEffect(() => {
    void loadLinks(linkedIds.taskIds, linkedIds.noteIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkSignature]);

  // Companies worth resolving: the ones a card points at directly, and the ones
  // behind the contacts it points at.
  const contextCompanyIds = useMemo(() => {
    const ids = new Set<string>();

    for (const item of allItems) {
      const direct = item.targetCompanyId;
      const viaPerson = (item.targetPerson as { companyId?: unknown } | null)
        ?.companyId;

      if (typeof direct === 'string' && direct !== '') {
        ids.add(direct);
      }

      if (typeof viaPerson === 'string' && viaPerson !== '') {
        ids.add(viaPerson);
      }
    }

    return [...ids].sort();
  }, [allItems]);

  const contextSignature = contextCompanyIds.join(',');

  useEffect(() => {
    void loadContext(contextCompanyIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextSignature]);

  // Files are grouped with everything else, so a record's card carries both
  // what changed on it and what was filed under it. A record with only files
  // still forms a card of its own.
  // The cap is enforced here as well as at fetch time: whatever arrives, the
  // feed never grows past FEED_LIMIT rows of change history.
  const changes = useMemo(() => {
    // The cap counts change events only; files ride along with the record they
    // belong to. Cutting them by the event window was tried and thrown away —
    // files are older than the latest edits, so it left one document out of a
    // hundred on screen.
    const events = visibleItems
      .filter((item) => item.name !== ATTACHMENT_EVENT)
      .slice(0, FEED_LIMIT);
    const files = visibleItems.filter((item) => item.name === ATTACHMENT_EVENT);

    return [...events, ...files].sort(byHappensAtDesc);
  }, [visibleItems]);

  const entries = useMemo<FeedEntry[]>(() => {
  const bulkCounts = new Map<string, number>();

  for (const item of changes) {
    const { subject, objectNameSingular, action, author, bucket } =
      describeBulk(item);
    const key = `${subject}|${objectNameSingular}|${action}|${author}|${bucket}`;

    bulkCounts.set(key, (bulkCounts.get(key) ?? 0) + 1);
  }

  const bulkEntries: { key: string; items: TimelineRecord[] }[] = [];
  const bulkIndex = new Map<string, { key: string; items: TimelineRecord[] }>();
  const groups: FeedGroup[] = [];
  const groupIndex = new Map<string, FeedGroup>();

  for (const item of changes) {
    const { subject, objectNameSingular, action, author, bucket } =
      describeBulk(item);
    const bulkKey = `${subject}|${objectNameSingular}|${action}|${author}|${bucket}`;

    if ((bulkCounts.get(bulkKey) ?? 0) >= BULK_THRESHOLD) {
      const existingBulk = bulkIndex.get(bulkKey);

      if (existingBulk === undefined) {
        const entry = { key: bulkKey, items: [item] };

        bulkIndex.set(bulkKey, entry);
        bulkEntries.push(entry);
      } else {
        existingBulk.items.push(item);
      }

      continue;
    }

    const target = resolveTarget(item);
    const key =
      target !== null
        ? `${target.objectNameSingular}:${target.recordId}`
        : `event:${String(item.id)}`;
    const existing = groupIndex.get(key);

    if (existing === undefined) {
      const group = { key, items: [item] };

      groupIndex.set(key, group);
      groups.push(group);
    } else {
      existing.items.push(item);
    }
  }

  const newestOf = (items: TimelineRecord[]) =>
    Math.max(...items.map((i) => new Date(String(i.happensAt)).getTime()));

  return [
    ...groups.map((g) => ({ kind: 'group' as const, ...g })),
    ...bulkEntries.map((b) => ({ kind: 'bulk' as const, ...b })),
  ].sort((a, b) => newestOf(b.items) - newestOf(a.items));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changes]);

  const unreadCount = visibleItems.filter(isUnread).length;

  const unreadEntries = entries.filter((e) => e.items.some(isUnread));
  const readEntries = entries.filter((e) => !e.items.some(isUnread));

  // Standard objects read from our own catalogue so the wording matches the
  // rest of the panel; everything else — custom objects included — takes the
  // label the workspace gave it.
  const labelForObject = (objectNameSingular: string) => {
    const known = OBJECT_LABELS[objectNameSingular as keyof typeof OBJECT_LABELS];

    return known !== undefined
      ? t(known)
      : (objectLabels[objectNameSingular] ?? objectNameSingular ?? t('Record'));
  };

  const describe = (item: TimelineRecord) => {
    const eventName = typeof item.name === 'string' ? item.name : '';
    const [eventSubject = '', action = ''] = eventName.split('.');
    const target = resolveTarget(item);
    // Events made through the API carry no workspaceMember — the ACTOR in
    // `createdBy` is the only attribution there is.
    const author =
      readDisplayName(item.workspaceMember) || readDisplayName(item.createdBy);

    // `linked-note.created` and friends describe something attached to the
    // target record rather than a change of the record itself.
    const linkedKind = eventSubject.startsWith('linked-')
      ? eventSubject.slice('linked-'.length)
      : null;
    const linkedName =
      typeof item.linkedRecordCachedName === 'string'
        ? item.linkedRecordCachedName
        : '';

    const objectNameSingular = target?.objectNameSingular ?? eventSubject;

    return {
      target,
      author,
      linkedKind,
      linkedName,
      objectNameSingular,
      changes: extractDiff(item.properties),
      objectLabel: labelForObject(objectNameSingular),
      actionLabel: (() => {
        const verb = ACTION_LABELS[action as keyof typeof ACTION_LABELS];

        if (linkedKind === null) {
          return verb !== undefined ? t(verb) : action;
        }

        const kind = LINKED_KIND_LABELS[linkedKind as keyof typeof LINKED_KIND_LABELS];
        const linkVerb =
          LINKED_ACTION_LABELS[action as keyof typeof LINKED_ACTION_LABELS];

        return `${kind !== undefined ? t(kind) : linkedKind} ${
          linkVerb !== undefined ? t(linkVerb) : action
        }`;
      })(),
    };
  };

  // SELECT fields carry their own labels and theme colours in metadata, so a
  // stage change renders as the same coloured labels the record page shows.
  const renderFieldValue = (
    objectNameSingular: string,
    field: string,
    raw: unknown,
    fallback: string,
  ) => {
    const option = fieldMeta[`${objectNameSingular}.${field}`]?.options?.[
      String(raw)
    ];

    if (option === undefined) {
      return fallback;
    }

    const color = THEME_COLORS[option.color] ?? palette.textMid;

    return (
      <span
        style={{
          padding: '1px 7px',
          borderRadius: '4px',
          background: `${color}26`,
          color,
          fontWeight: 500,
          whiteSpace: 'nowrap',
        }}
      >
        {option.label}
      </span>
    );
  };

  const renderFileMark = (fileName: string) => {
    const Icon = getFileIcon(fileName);

    return <Icon size={16} stroke={1.7} color={palette.textLight} />;
  };

  const renderPayload = (
    item: TimelineRecord,
    described: ReturnType<typeof describe>,
    accentColor: string,
  ) => (
    <>
      {described.linkedKind !== null && described.linkedName !== '' && (
        <div
          style={{
            marginTop: '5px',
            paddingLeft: '8px',
            borderLeft: `2px solid ${accentColor}`,
            fontSize: '0.92rem',
            fontWeight: 400,
            color: palette.textMid,
            lineHeight: '1.5',
            overflowWrap: 'anywhere',
          }}
        >
          {described.linkedName}
        </div>
      )}

      {described.changes.map((change) => {
        // What somebody wrote is speech, not a field value. Buzz and Tasks
        // render it as a comment; the feed used to print the same text as
        // `Body: appended: …`, which read like a database column. Same content,
        // same quoted shape — the author is already on the line above.
        const written = isRichTextValue(change.beforeRaw) || isRichTextValue(change.afterRaw)
          ? readNoteEdit({
              properties: { diff: { bodyV2: { before: change.beforeRaw, after: change.afterRaw } } },
            } as TimelineRecord)
          : null;

        if (written !== null && written.text !== '') {
          return (
            <div
              key={change.field}
              style={{
                marginTop: '5px',
                paddingLeft: '8px',
                borderLeft: `2px solid ${palette.border}`,
                fontSize: '0.92rem',
                fontWeight: 400,
                color: palette.textMid,
                lineHeight: '1.55',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
              }}
            >
              {written.isRewrite && (
                <span style={{ color: palette.textLight }}>
                  {t('rewrote the text')}{' '}
                </span>
              )}
              {written.text}
            </div>
          );
        }

        return (
        <div
          key={change.field}
          style={{
            marginTop: '4px',
            fontSize: '0.92rem',
            fontWeight: 400,
            color: palette.text,
            lineHeight: '1.6',
            overflowWrap: 'anywhere',
          }}
        >
          <span style={{ color: palette.textLight }}>
            {fieldMeta[`${described.objectNameSingular}.${change.field}`]
              ?.label ?? change.field}
            :{' '}
          </span>
          {isRichTextValue(change.beforeRaw) || isRichTextValue(change.afterRaw) ? (
            describeRichTextChange(change.beforeRaw, change.afterRaw)
          ) : (
            <>
          {renderFieldValue(
            described.objectNameSingular,
            change.field,
            change.beforeRaw,
            formatValue(change.beforeRaw, memberNames),
          )}
          <span style={{ color: palette.textLight }}> → </span>
          {renderFieldValue(
            described.objectNameSingular,
            change.field,
            change.afterRaw,
            formatValue(change.afterRaw, memberNames),
          )}
            </>
          )}
        </div>
        );
      })}
    </>
  );

  // Tasks and notes hang off the record they were filed under, and that
  // record — usually a deal — is what the reader is actually following.
  // A deal matters more than the contact it goes through, so it leads.
  const LINK_RANK: Record<string, number> = { opportunity: 0, company: 1 };

  // Context for a record that carries no link rows of its own: a contact lends
  // its company, a company lends the deal that is still open on it.
  const contextFor = (item: TimelineRecord): ResolvedTarget[] => {
    const viaPerson = (item.targetPerson as { companyId?: unknown } | null)
      ?.companyId;
    const companyId =
      typeof item.targetCompanyId === 'string' && item.targetCompanyId !== ''
        ? item.targetCompanyId
        : typeof viaPerson === 'string'
          ? viaPerson
          : '';

    if (companyId === '') {
      return [];
    }

    const chips: ResolvedTarget[] = [];
    const deal = companyDeals[companyId];

    if (deal !== undefined) {
      chips.push({
        objectNameSingular: 'opportunity',
        recordId: deal.id,
        label: deal.name,
      });
    }

    // The company itself is redundant on a card that already leads with it.
    if (item.targetCompanyId !== companyId && companyNames[companyId] !== undefined) {
      chips.push({
        objectNameSingular: 'company',
        recordId: companyId,
        label: companyNames[companyId],
      });
    }

    return chips;
  };

  const relatedRecords = (objectNameSingular: string, recordId: string) => {
    const rows =
      objectNameSingular === 'task'
        ? taskTargets.filter((link) => String(link.taskId) === recordId)
        : objectNameSingular === 'note'
          ? noteTargets.filter((link) => String(link.noteId) === recordId)
          : [];

    return rows
      .map((link) => resolveTarget(link))
      .filter((link): link is ResolvedTarget => link !== null)
      .sort(
        (a, b) =>
          (LINK_RANK[a.objectNameSingular] ?? 2) -
          (LINK_RANK[b.objectNameSingular] ?? 2),
      )
      .slice(0, 2);
  };

  const renderHead = (item: TimelineRecord, unread: boolean) => {
    const described = describe(item);
    const { target, author, objectLabel, actionLabel, objectNameSingular } =
      described;
    const isBroken = target === null;
    // Own links first — a task really is filed under that deal. Borrowed
    // context fills the gap for records that have none: a contact's company,
    // that company's open deal.
    const ownLinks = isBroken
      ? []
      : relatedRecords(objectNameSingular, String(target.recordId));
    const recordLinks =
      ownLinks.length > 0 ? ownLinks : contextFor(item).slice(0, 2);
    const isActive = unread && !isBroken;
    const classColor = getObjectColor(objectNameSingular);
    const dotColor = isActive ? classColor : palette.rail;
    const chipLabel = !isBroken && target.label !== '' ? target.label : objectLabel;

    return (
      <div
        onClick={isBroken ? undefined : () => openRecord(target)}
        style={{
          display: 'flex',
          gap: '11px',
          padding: '10px 16px 0',
          cursor: isBroken ? 'default' : 'pointer',
        }}
      >
        {SHOW_TIMELINE_RAIL && (
          <div
            style={{
              position: 'relative',
              width: '9px',
              flexShrink: 0,
              display: 'flex',
              justifyContent: 'center',
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                width: '1px',
                background: palette.rail,
              }}
            />
            <div
              style={{
                position: 'relative',
                marginTop: '5px',
                width: unread ? '7px' : '5px',
                height: unread ? '7px' : '5px',
                borderRadius: '50%',
                background: isBroken ? 'transparent' : dotColor,
                border: isBroken ? `1px solid ${palette.textLight}` : 'none',
                boxShadow: unread ? `0 0 0 3px ${dotColor}4D` : 'none',
                alignSelf: 'flex-start',
              }}
            />
          </div>
        )}

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: '10px',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                minWidth: 0,
                flexWrap: 'wrap',
              }}
            >
              {!isBroken && (
                <InlineAvatar
                  size={15}
                  label={chipLabel}
                  color={isActive ? `${classColor}22` : palette.mutedFill}
                  textColor={isActive ? classColor : palette.mutedGlyph}
                  avatarUrl={target.avatarUrl}
                />
              )}
              <span
                style={{
                  fontSize: '0.92rem',
                  fontWeight: unread ? 500 : 400,
                  color: isBroken ? palette.textLight : palette.text,
                  textDecoration: isBroken ? 'line-through' : 'none',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: '190px',
                }}
              >
                {chipLabel}
              </span>
            </div>

            <span
              style={{
                fontSize: '0.92rem',
                fontWeight: 400,
                color: palette.textLight,
                whiteSpace: 'nowrap',
              }}
            >
              {formatAgo(String(item.happensAt))}
            </span>
          </div>

          <div
            style={{
              marginTop: '2px',
              fontSize: '0.92rem',
              fontWeight: 400,
              color: palette.textLight,
              lineHeight: '1.5',
            }}
          >
            {objectLabel} · {actionLabel}
            {author !== '' && (
              <>
                {' · '}
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    verticalAlign: 'middle',
                  }}
                >
                  <InlineAvatar
                    size={14}
                    label={author}
                    color={palette.mutedFill}
                    textColor={palette.textMid}
                    avatarUrl={
                      memberAvatars[
                        readMemberId(item.workspaceMember) ??
                          readMemberId(item.createdBy) ??
                          ''
                      ]
                    }
                  />
                  {author}
                </span>
              </>
            )}
            {isBroken && ` · ${t('record deleted, cannot open')}`}
          </div>

          {recordLinks.length > 0 && (
            <div
              style={{
                marginTop: '5px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                flexWrap: 'wrap',
                rowGap: '5px',
              }}
            >
              {recordLinks.map((link) => {
                const linkColor = getObjectColor(link.objectNameSingular);

                return (
                  <span
                    key={link.recordId}
                    onClick={(event) => {
                      event.stopPropagation();
                      openRecord(link);
                    }}
                    title={t('Open: {label}', { label: link.label })}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '5px',
                      maxWidth: '180px',
                      padding: '1px 7px 1px 3px',
                      borderRadius: '4px',
                      background: `${linkColor}14`,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <InlineAvatar
                      size={14}
                      label={link.label}
                      color={`${linkColor}2E`}
                      textColor={linkColor}
                      avatarUrl={link.avatarUrl}
                    />
                    <span
                      style={{
                        fontSize: '0.92rem',
                        color: palette.textMid,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {link.label}
                    </span>
                  </span>
                );
              })}
            </div>
          )}

          {renderPayload(item, described, isActive ? classColor : palette.rail)}
        </div>
      </div>
    );
  };

  const renderFollowUp = (item: TimelineRecord) => {
    const described = describe(item);

    return (
      <div
        key={String(item.id)}
        style={{
          padding: '6px 16px 0',
          marginLeft: SHOW_TIMELINE_RAIL ? '20px' : '0',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: '10px',
          }}
        >
          <span
            style={{
              fontSize: '0.92rem',
              fontWeight: 400,
              color: palette.textLight,
            }}
          >
            {described.actionLabel}
            {described.author !== '' ? ` · ${described.author}` : ''}
          </span>
          <span
            style={{
              fontSize: '0.92rem',
              fontWeight: 400,
              color: palette.textLight,
              whiteSpace: 'nowrap',
            }}
          >
            {formatAgo(String(item.happensAt))}
          </span>
        </div>
        {renderPayload(item, described, palette.rail)}
      </div>
    );
  };

  const renderGroup = (group: FeedGroup, unread: boolean) => {
    // Files are not "one more event on this record" — they are things you come
    // back to. They stay visible under the head instead of hiding behind the
    // counter, and a card made only of files leads with the newest one.
    const files = group.items.filter((item) => item.name === ATTACHMENT_EVENT);
    const events = group.items.filter((item) => item.name !== ATTACHMENT_EVENT);
    const [head, ...rest] = events.length > 0 ? events : files;
    const attachments = events.length > 0 ? files : files.slice(1);
    const isExpanded = expandedKeys.includes(group.key);

    // A feed row opens the record exactly like a card does, so it answers the
    // cursor the same way. A row has no frame to outline, so the reaction is a
    // fill — the standard list affordance — rather than the card's border.
    const isRowHovered = hoveredCard === group.key;

    return (
      <div
        key={group.key}
        onMouseEnter={() => setHoveredCard(group.key)}
        onMouseLeave={() => setHoveredCard(null)}
        style={{
          paddingBottom: '12px',
          borderBottom: SHOW_TIMELINE_RAIL
            ? 'none'
            : `1px solid ${palette.border}`,
          background: isRowHovered ? palette.hover : 'transparent',
          transition: 'background 140ms ease',
        }}
      >
        {renderHead(head, unread)}

        {attachments.length > 0 && (
          <div
            style={{
              padding: '5px 16px 0',
              marginLeft: SHOW_TIMELINE_RAIL ? '20px' : '0',
            }}
          >
            {attachments.map((file) => {
              const fileName =
                typeof file.linkedRecordCachedName === 'string'
                  ? file.linkedRecordCachedName
                  : t('Document');

              return (
                <div
                  key={String(file.id)}
                  style={{
                    marginTop: '4px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    minWidth: 0,
                  }}
                >
                  {renderFileMark(fileName)}
                  <span
                    style={{
                      fontSize: '0.92rem',
                      fontWeight: 400,
                      color: palette.textMid,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {fileName}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {rest.length > 0 && (
          <div
            style={{
              padding: '6px 16px 0',
              marginLeft: SHOW_TIMELINE_RAIL ? '20px' : '0',
            }}
          >
            <button
              type="button"
              onClick={() =>
                setExpandedKeys((keys) =>
                  keys.includes(group.key)
                    ? keys.filter((key) => key !== group.key)
                    : [...keys, group.key],
                )
              }
              style={{
                border: 'none',
                background: 'transparent',
                padding: 0,
                fontFamily: 'inherit',
                fontSize: '0.92rem',
                fontWeight: 400,
                color: palette.textMid,
                cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              {isExpanded
                ? t('Collapse')
                : t('{count} more events on this record', { count: rest.length })}
            </button>
          </div>
        )}

        {isExpanded && rest.map(renderFollowUp)}
      </div>
    );
  };


  const renderTask = (task: TimelineRecord) => {
    const due = describeDue(task.dueAt);
    const isOverdue = due.overdueDays > 0;
    const title = typeof task.title === 'string' ? task.title : t('Untitled');
    const assignee = readDisplayName(task.assignee);
    const classColor = getObjectColor('task');
    // A deal matters more than the contact it goes through, so it leads.
    const RANK: Record<string, number> = { opportunity: 0, company: 1 };
    const links = taskTargets
      .filter((link) => link.taskId === task.id)
      .map((link) => resolveTarget(link))
      .filter((link): link is ResolvedTarget => link !== null)
      .sort((a, b) => (RANK[a.objectNameSingular] ?? 2) - (RANK[b.objectNameSingular] ?? 2));

    const comments = taskEdits
      .filter((edit) => edit.targetTaskId === task.id)
      .map((edit) => ({ edit, parsed: readNoteEdit(edit) }))
      // An empty `before` means the body was written for the first time —
      // that is the task's own description, not a comment on it.
      .filter(({ parsed }) => parsed.text !== '' && parsed.before !== '');

    const cardKey = `task-card-${String(task.id)}`;
    const isCardHovered = hoveredCard === cardKey;

    return (
      <div
        key={String(task.id)}
        onMouseEnter={() => setHoveredCard(cardKey)}
        onMouseLeave={() => setHoveredCard(null)}
        style={{
          margin: '16px 12px',
          border: `1px solid ${
            isCardHovered ? palette.cardHoverBorder : palette.border
          }`,
          borderRadius: '10px',
          background: colorScheme === 'dark' ? '#1B1B1B' : '#FFFFFF',
          overflow: 'hidden',
          transition: 'border-color 140ms ease',
        }}
      >
      <div
        onClick={() =>
          openRecord({
            objectNameSingular: 'task',
            recordId: String(task.id),
            label: title,
          })
        }
        style={{
          display: 'flex',
          gap: '11px',
          padding: '12px 14px',
          cursor: 'pointer',
        }}
      >
        <div style={{ paddingTop: '1px' }}>
          <InlineAvatar
            size={15}
            label={title}
            color={`${classColor}22`}
            textColor={classColor}
          />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: '10px',
            }}
          >
            <span
              style={{
                fontSize: '0.92rem',
                fontWeight: isOverdue ? 500 : 400,
                color: palette.text,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {title}
            </span>
            <span
              style={{
                fontSize: '0.92rem',
                fontWeight: 400,
                color: isOverdue ? '#D45453' : palette.textLight,
                whiteSpace: 'nowrap',
              }}
            >
              {due.label}
            </span>
          </div>

          <div
            style={{
              marginTop: '4px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '0.92rem',
              fontWeight: 400,
              color: palette.textLight,
              flexWrap: 'nowrap',
              whiteSpace: 'nowrap',
            }}
          >
            {renderFieldValue('task', 'status', task.status, String(task.status))}
            {assignee !== '' && (
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {assignee}
              </span>
            )}
          </div>

          {/* Links get a line of their own: cramming them next to the status
              broke the assignee name across two lines. Overflow scrolls. */}
          {links.length > 0 && (
            <div
              style={{
                marginTop: '5px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                // Wrap rather than scroll: a scrollbar inside a card reads as
                // a defect, and links are few enough to fold onto a new line.
                flexWrap: 'wrap',
                rowGap: '5px',
              }}
            >
            {links.map((link) => {
              const linkColor = getObjectColor(link.objectNameSingular);

              return (
                <span
                  key={link.recordId}
                  onClick={(event) => {
                    event.stopPropagation();
                    openRecord(link);
                  }}
                  title={t("Open: {label}", { label: link.label })}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '5px',
                    maxWidth: '180px',
                    padding: '1px 7px 1px 3px',
                    borderRadius: '4px',
                    background: `${linkColor}14`,
                    cursor: 'pointer',
                    flexShrink: 0,
                    whiteSpace: 'nowrap',
                  }}
                >
                  <InlineAvatar
                    size={14}
                    label={link.label}
                    color={`${linkColor}2E`}
                    textColor={linkColor}
                    avatarUrl={link.avatarUrl}
                  />
                  <span
                    style={{
                      color: palette.textMid,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {link.label}
                  </span>
                </span>
              );
            })}
            </div>
          )}

        </div>
        </div>

          {comments.length > 0 && (
            <div
              style={{
                borderTop: `1px solid ${palette.border}`,
                background: colorScheme === 'dark' ? '#191919' : '#FAFAFA',
                padding: '4px 0',
              }}
            >
              {(() => {
                const key = `task-${String(task.id)}`;
                const thread = splitThread(comments, key);

                return thread.hidden > 0 ? (
                  <div style={{ padding: '4px 14px 0' }}>
                    {renderThreadToggle(thread.hidden, key)}
                  </div>
                ) : null;
              })()}

              {splitThread(comments, `task-${String(task.id)}`).visible.map(
                ({ edit, parsed }) =>
                  renderComment(
                    edit,
                    parsed,
                    () =>
                      openRecord({
                        objectNameSingular: 'task',
                        recordId: String(task.id),
                        label: title,
                      }),
                    t('Open task'),
                  ),
              )}
            </div>
          )}
      </div>
    );
  };

  // A comment looks the same wherever it appears — Buzz and tasks were drifting
  // apart because they were written at different times.
  const renderComment = (
    edit: TimelineRecord,
    parsed: ReturnType<typeof readNoteEdit>,
    onOpen: () => void,
    openLabel: string,
  ) => {
    const commenter =
      readDisplayName(edit.workspaceMember) || readDisplayName(edit.updatedBy);
    const editId = String(edit.id);
    const avatarUrl =
      memberAvatars[
        readMemberId(edit.workspaceMember) ?? readMemberId(edit.updatedBy) ?? ''
      ];

    return (
      <div
        key={editId}
        onClick={() =>
          setExpandedComments((keys) =>
            keys.includes(editId)
              ? keys.filter((key) => key !== editId)
              : [...keys, editId],
          )
        }
        onMouseEnter={() => setHoveredId(editId)}
        onMouseLeave={() => setHoveredId(null)}
        title={t("Show what this was written against")}
        style={{
          display: 'flex',
          gap: '8px',
          padding: '8px 14px',
          alignItems: 'flex-start',
          cursor: 'pointer',
          background: hoveredId === editId ? palette.hover : 'transparent',
        }}
      >
        <InlineAvatar
          size={22}
          label={commenter !== '' ? commenter : '?'}
          color={palette.mutedFill}
          textColor={palette.textMid}
          avatarUrl={avatarUrl}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span
              style={{
                fontSize: '0.92rem',
                fontWeight: 500,
                color: palette.text,
              }}
            >
              {commenter !== '' ? commenter : t('Someone')}
            </span>
            <span style={{ fontSize: '0.85rem', color: palette.textLight }}>
              {formatAgo(String(edit.happensAt))}
            </span>
            {parsed.isRewrite && (
              <span style={{ fontSize: '0.85rem', color: palette.textLight }}>
                {t('rewrote the text')}
              </span>
            )}
          </div>

          <div
            style={{
              marginTop: '2px',
              fontSize: '0.92rem',
              fontWeight: 400,
              color: palette.textMid,
              lineHeight: '1.55',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {parsed.text}
          </div>

          {expandedComments.includes(editId) && (
            <div
              style={{
                marginTop: '8px',
                paddingLeft: '10px',
                borderLeft: `2px solid ${palette.border}`,
              }}
            >
              {readContextBefore(parsed.before).map((block, index) => (
                <div
                  key={index}
                  style={{
                    fontSize: '0.92rem',
                    fontWeight: 400,
                    color: palette.textLight,
                    lineHeight: '1.55',
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                    marginBottom: '4px',
                  }}
                >
                  {block}
                </div>
              ))}

              <div
                style={{
                  marginTop: '2px',
                  padding: '4px 7px',
                  borderRadius: '4px',
                  background: `${getObjectColor('note')}1F`,
                  fontSize: '0.92rem',
                  fontWeight: 400,
                  color: palette.text,
                  lineHeight: '1.55',
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                }}
              >
                {parsed.text}
              </div>

              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpen();
                }}
                style={{
                  marginTop: '6px',
                  border: 'none',
                  background: 'transparent',
                  padding: 0,
                  fontFamily: 'inherit',
                  fontSize: '0.85rem',
                  color: palette.textMid,
                  cursor: 'pointer',
                  textDecoration: 'underline',
                }}
              >
                {openLabel}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderBuzzPost = (post: (typeof buzzPosts)[number]) => {
    const { note, comments, originalBody } = post;
    const title = typeof note.title === 'string' ? note.title : t('Untitled');
    const author = readDisplayName(note.createdBy);
    const noteColor = getObjectColor('note');

    const cardKey = `post-${String(note.id)}`;
    const isCardHovered = hoveredCard === cardKey;

    return (
      <div
        key={String(note.id)}
        onMouseEnter={() => setHoveredCard(cardKey)}
        onMouseLeave={() => setHoveredCard(null)}
        style={{
          margin: '16px 12px',
          border: `1px solid ${
            isCardHovered ? palette.cardHoverBorder : palette.border
          }`,
          borderRadius: '10px',
          background: colorScheme === 'dark' ? '#1B1B1B' : '#FFFFFF',
          overflow: 'hidden',
          transition: 'border-color 140ms ease',
        }}
      >
        <div
          onClick={() =>
            openRecord({
              objectNameSingular: 'note',
              recordId: String(note.id),
              label: title,
            })
          }
          style={{ padding: '12px 14px', cursor: 'pointer' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <InlineAvatar
              size={28}
              label={author !== '' ? author : title}
              color={`${noteColor}22`}
              textColor={noteColor}
              avatarUrl={memberAvatars[readMemberId(note.createdBy) ?? '']}
            />
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: '0.92rem',
                  fontWeight: 500,
                  color: palette.text,
                }}
              >
                {author !== '' ? author : t('Unknown author')}
              </div>
              <div style={{ fontSize: '0.85rem', color: palette.textLight }}>
                {formatAgo(String(note.createdAt))}
              </div>
            </div>
          </div>

          <div
            style={{
              marginTop: '10px',
              fontSize: '0.92rem',
              fontWeight: 500,
              color: palette.text,
            }}
          >
            {title}
          </div>

          {originalBody !== '' && (
            <div
              style={{
                marginTop: '4px',
                fontSize: '0.92rem',
                fontWeight: 400,
                color: palette.textMid,
                lineHeight: '1.55',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
              }}
            >
              {originalBody}
            </div>
          )}
        </div>

        {comments.length > 0 && (
          <div
            style={{
              borderTop: `1px solid ${palette.border}`,
              background: colorScheme === 'dark' ? '#191919' : '#FAFAFA',
              padding: '4px 0',
            }}
          >
            {(() => {
              const thread = splitThread(comments, `note-${String(note.id)}`);

              return thread.hidden > 0 ? (
                <div style={{ padding: '4px 14px 0' }}>
                  {renderThreadToggle(
                    thread.hidden,
                    `note-${String(note.id)}`,
                  )}
                </div>
              ) : null;
            })()}

            {splitThread(comments, `note-${String(note.id)}`).visible.map(
              ({ edit, parsed }) =>
                renderComment(
                  edit,
                  parsed,
                  () => openNoteBody(String(note.id)),
                  t('Open note text'),
                ),
            )}
          </div>
        )}
      </div>
    );
  };

  // A thread reads oldest-first, but when it grows the recent replies are the
  // ones that matter — so the older head is folded away.
  const VISIBLE_COMMENTS = 3;

  const splitThread = <T,>(comments: T[], key: string) => {
    if (comments.length <= VISIBLE_COMMENTS || expandedThreads.includes(key)) {
      return { hidden: 0, visible: comments };
    }

    return {
      hidden: comments.length - VISIBLE_COMMENTS,
      visible: comments.slice(-VISIBLE_COMMENTS),
    };
  };

  const renderThreadToggle = (hidden: number, key: string) => (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        setExpandedThreads((keys) =>
          keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key],
        );
      }}
      style={{
        border: 'none',
        background: 'transparent',
        padding: 0,
        marginTop: '6px',
        fontFamily: 'inherit',
        fontSize: '0.92rem',
        fontWeight: 400,
        color: palette.textMid,
        cursor: 'pointer',
        textDecoration: 'underline',
      }}
    >
      {t('{hidden} more comments', { hidden })}
    </button>
  );

  const renderBulk = (
    entry: { key: string; items: TimelineRecord[] },
    unread: boolean,
  ) => {
    const [head] = entry.items;
    const described = describe(head);
    const author = described.author;
    const isExpanded = expandedKeys.includes(entry.key);
    const classColor = getObjectColor(described.objectNameSingular);
    const isActive = unread;
    // Twelve files uploaded to deals is "12 × document", not "12 × Deal": the
    // target object is what they hang on, not what appeared.
    const linkedMessage =
      described.linkedKind === null
        ? undefined
        : LINKED_KIND_LABELS[
            described.linkedKind as keyof typeof LINKED_KIND_LABELS
          ];
    const verbMessage =
      LINKED_ACTION_LABELS[
        String(head.name ?? '').split('.')[1] as keyof typeof LINKED_ACTION_LABELS
      ];
    const bulkLabel =
      linkedMessage !== undefined ? t(linkedMessage) : described.objectLabel;
    // `actionLabel` already reads "document added" for linked events, which
    // would repeat the label above — the bare verb is enough there.
    const bulkAction =
      linkedMessage !== undefined && verbMessage !== undefined
        ? t(verbMessage)
        : described.actionLabel;

    const isRowHovered = hoveredCard === entry.key;

    return (
      <div
        key={entry.key}
        onMouseEnter={() => setHoveredCard(entry.key)}
        onMouseLeave={() => setHoveredCard(null)}
        style={{
          paddingBottom: '12px',
          borderBottom: SHOW_TIMELINE_RAIL
            ? 'none'
            : `1px solid ${palette.border}`,
          background: isRowHovered ? palette.hover : 'transparent',
          transition: 'background 140ms ease',
        }}
      >
        <div style={{ display: 'flex', gap: '11px', padding: '10px 16px 0' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: '10px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  minWidth: 0,
                }}
              >
                <InlineAvatar
                  size={15}
                  label={bulkLabel}
                  color={isActive ? `${classColor}22` : palette.mutedFill}
                  textColor={isActive ? classColor : palette.mutedGlyph}
                />
                <span
                  style={{
                    fontSize: '0.92rem',
                    fontWeight: unread ? 500 : 400,
                    color: palette.text,
                  }}
                >
                  {t('{count} × {object}', {
                    count: entry.items.length,
                    object: bulkLabel,
                  })}
                </span>
                <span
                  style={{
                    fontSize: '0.92rem',
                    fontWeight: 400,
                    color: palette.textLight,
                  }}
                >
                  {bulkAction}
                </span>
              </div>

              <span
                style={{
                  fontSize: '0.92rem',
                  fontWeight: 400,
                  color: palette.textLight,
                  whiteSpace: 'nowrap',
                }}
              >
                {formatAgo(String(head.happensAt))}
              </span>
            </div>

            <div
              style={{
                marginTop: '2px',
                fontSize: '0.92rem',
                fontWeight: 400,
                color: palette.textLight,
              }}
            >
              {t('bulk change')}
              {author !== '' ? ` · ${author}` : ''}
            </div>

            <button
              type="button"
              onClick={() =>
                setExpandedKeys((keys) =>
                  keys.includes(entry.key)
                    ? keys.filter((key) => key !== entry.key)
                    : [...keys, entry.key],
                )
              }
              style={{
                marginTop: '6px',
                border: 'none',
                background: 'transparent',
                padding: 0,
                fontFamily: 'inherit',
                fontSize: '0.92rem',
                fontWeight: 400,
                color: palette.textMid,
                cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              {isExpanded ? t('Collapse') : t('Show records')}
            </button>

            {isExpanded &&
              entry.items.slice(0, 20).map((item) => {
                const target = resolveTarget(item);

                return (
                  <div
                    key={String(item.id)}
                    onClick={
                      target === null ? undefined : () => openRecord(target)
                    }
                    style={{
                      marginTop: '4px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px',
                      fontSize: '0.92rem',
                      fontWeight: 400,
                      color: target === null ? palette.textLight : palette.text,
                      cursor: target === null ? 'default' : 'pointer',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {typeof item.linkedRecordCachedName === 'string' &&
                    item.linkedRecordCachedName !== ''
                      ? // A linked note or task names itself; the click opens
                        // the record it hangs on.
                        `${item.linkedRecordCachedName}${
                          target !== null && target.label !== ''
                            ? ` · ${target.label}`
                            : ''
                        }`
                      : target !== null && target.label !== ''
                        ? target.label
                        : bulkLabel}
                  </div>
                );
              })}
          </div>
        </div>
      </div>
    );
  };

  const renderSectionHeader = (label: string, count?: number) => (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '16px 16px 6px',
      }}
    >
      <span
        style={{ fontSize: '0.85rem', fontWeight: 400, color: palette.textLight }}
      >
        {label}
        {count !== undefined ? ` · ${count}` : ''}
      </span>
      <div style={{ flex: 1, height: '1px', background: palette.border }} />
    </div>
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        color: palette.text,
        fontFamily:
          'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          padding: '10px 16px',
          borderBottom: `1px solid ${palette.border}`,
          // A narrow panel must not stretch or wrap the controls — the strip
          // scrolls sideways instead.
          flexWrap: 'nowrap',
          overflowX: 'auto',
          scrollbarWidth: 'thin',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '7px',
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
        >
          {/* Three tabs that never move. A breadcrumb here meant the strip was
              rebuilt on every switch and the whole row jumped sideways. */}
          <ToolbarButton
            label={t('Feed')}
            title={t('Everything that changed in the workspace.')}
            isActive={view === 'feed'}
            activeColor={ACCENT_BLUE}
            onClick={() => setView('feed')}
            background={palette.buttonBackground}
            color={palette.textMid}
          />
          <ToolbarButton
            label="Buzz"
            title={t('Team notes and the comments on them.')}
            isActive={view === 'buzz'}
            activeColor={ACCENT_BLUE}
            onClick={() => setView('buzz')}
            background={palette.buttonBackground}
            color={palette.textMid}
          />
          <ToolbarButton
            label={t('Tasks')}
            title={t('Open tasks: overdue first, then by due date.')}
            isActive={view === 'tasks'}
            activeColor={ACCENT_BLUE}
            onClick={() => setView('tasks')}
            background={palette.buttonBackground}
            color={palette.textMid}
          />
          {view === 'tasks' && overdueTasks.length > 0 && (
            <span
              title={t("Overdue: {count}", { count: overdueTasks.length })}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: '19px',
                height: '19px',
                padding: '0 5px',
                borderRadius: '10px',
                border: '1px solid #D45453',
                fontSize: '0.85rem',
                fontWeight: 400,
                color: '#D45453',
              }}
            >
              {overdueTasks.length}
            </span>
          )}
          {view === 'tasks' && openTasks.length > 0 && (
            <span
              title={t("Open tasks in total: {count}", { count: openTasks.length })}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: '19px',
                height: '19px',
                padding: '0 5px',
                borderRadius: '10px',
                border: `1px solid ${ACCENT_BLUE}`,
                fontSize: '0.85rem',
                fontWeight: 400,
                color: ACCENT_BLUE,
              }}
            >
              {openTasks.length}
            </span>
          )}
          {view === 'feed' && unreadCount > 0 && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: '19px',
                height: '19px',
                padding: '0 5px',
                borderRadius: '10px',
                border: `1px solid ${palette.rail}`,
                fontSize: '0.85rem',
                fontWeight: 400,
                color: palette.textMid,
              }}
            >
              {unreadCount}
            </span>
          )}
          {view === 'feed' && unreadCount > 0 && (
            <ToolbarButton
              label={t("Mark all read")}
              title={t("Mark every event as read")}
              onClick={() => void markAllAsRead()}
              background={palette.buttonBackground}
              color={palette.textMid}
            />
          )}
        </div>

        <div
          style={{ display: 'flex', gap: '6px', flexShrink: 0, whiteSpace: 'nowrap' }}
        >
          {view === 'buzz' ? (
            // Buzz is the team wall: everyone's notes, always. A personal
            // filter there would contradict what the section is for.
            <></>
          ) : enforcement === 'server' ? (
            <span
              title={t("Row-level permissions are on: Twenty scopes the data itself and the panel adds no filtering.")}
              style={{
                padding: '4px 9px',
                borderRadius: '4px',
                background: palette.buttonBackground,
                color: palette.textMid,
                fontSize: '0.85rem',
                fontWeight: 400,
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {t('Access: server')}
            </span>
          ) : (
            <ToolbarButton
              label={t("Only mine")}
              isActive={scope === 'mine'}
              activeColor={ACCENT_BLUE}
              title={
                scope === 'mine'
                  ? t('Filter on: only what relates to you. Click to see everything.')
                  : t('Filter off: everything the server returned. Click to keep only yours.')
              }
              onClick={() => setScope(scope === 'mine' ? 'all' : 'mine')}
              background={palette.buttonBackground}
              color={palette.textMid}
            />
          )}

        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: '12px' }}>
        {isLoading && (
          <div style={{ padding: '16px', fontSize: '0.92rem', color: palette.textLight }}>
            {t('Loading…')}
          </div>
        )}

        {error !== null && (
          <div style={{ padding: '16px', fontSize: '0.92rem', color: '#D45453' }}>
            {t('Could not load the feed: {error}', { error })}
          </div>
        )}

        {view === 'feed' && !isLoading && error === null && items.length === 0 && (
          <div style={{ padding: '16px', fontSize: '0.92rem', color: palette.textLight }}>
            {t('Nothing has happened yet. Create or change any record and the event shows up here.')}
          </div>
        )}

        {view === 'feed' && (
          <>
            {/* The setting is workspace-wide and easy to forget about. Saying
                so beats an empty strip that reads as a broken panel. */}
            {!SHOW_ATTACHMENTS && (
              <>
                {renderSectionHeader(t('Documents'), 0)}
                <div
                  style={{
                    padding: '2px 16px 6px',
                    fontSize: '0.92rem',
                    color: palette.textLight,
                  }}
                >
                  {t('Turned off in the app settings — SHOW_ATTACHMENTS')}
                </div>
              </>
            )}

            {unreadEntries.length > 0 &&
              renderSectionHeader(t('New'), unreadEntries.length)}
            {unreadEntries.map((entry) =>
              entry.kind === 'bulk'
                ? renderBulk(entry, true)
                : renderGroup(entry, true),
            )}

            {readEntries.length > 0 &&
              unreadEntries.length > 0 &&
              renderSectionHeader(t('Earlier'), readEntries.length)}
            {readEntries.map((entry) =>
              entry.kind === 'bulk'
                ? renderBulk(entry, false)
                : renderGroup(entry, false),
            )}

            {!isLoading && changes.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  padding: '14px 16px 4px',
                }}
              >
                {!isFeedExhausted &&
                  loadedEvents.length < FEED_LIMIT &&
                  loadedEvents.length < feedTotal && (
                  <ToolbarButton
                    label={isLoadingMore ? t('Loading…') : t('Show more')}
                    title={t('Load the previous page of events')}
                    onClick={() => void loadMore()}
                    background={palette.buttonBackground}
                    color={palette.textMid}
                  />
                )}
                <span style={{ fontSize: '0.85rem', color: palette.textLight }}>
                  {/* Against what is reachable, not against the whole history:
                      the feed stops at FEED_LIMIT, and the server's total also
                      counts events the panel never shows. */}
                  {t('{loaded} of {total} events', {
                    loaded: loadedEvents.length,
                    total: Math.min(FEED_LIMIT, feedTotal),
                  })}
                </span>
              </div>
            )}


          </>
        )}

        {view === 'buzz' && (
          <>
            {buzzPosts.map(renderBuzzPost)}
            {buzzPosts.length === 0 && (
              <div
                style={{
                  padding: '16px',
                  fontSize: '0.92rem',
                  color: palette.textLight,
                }}
              >
                {t('No notes yet.')}
              </div>
            )}
          </>
        )}

        {view === 'tasks' && (
          <>
            {overdueTasks.length > 0 &&
              renderSectionHeader(t('Overdue'), overdueTasks.length)}
            {overdueTasks.map(renderTask)}

            {upcomingTasks.length > 0 &&
              renderSectionHeader(
                overdueTasks.length > 0 ? t('By due date') : t('Upcoming'),
                upcomingTasks.length,
              )}
            {upcomingTasks.map(renderTask)}

            {openTasks.length === 0 && (
              <div
                style={{
                  padding: '16px',
                  fontSize: '0.92rem',
                  color: palette.textLight,
                }}
              >
                {t('No open tasks.')}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default defineFrontComponent({
  universalIdentifier: ACTIVITY_FEED_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  name: 'activity-feed',
  description: 'Workspace activity feed built on the standard timelineActivity',
  component: ActivityFeed,
});
