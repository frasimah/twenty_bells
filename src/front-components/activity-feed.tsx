import { defineFrontComponent } from 'twenty-sdk/define';
import {
  getApplicationVariable,
  openSidePanelPage,
  SidePanelPages,
  useColorScheme,
  useUserId,
} from 'twenty-sdk/front-component';
import { useCallback, useEffect, useState } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';

import { ACTIVITY_FEED_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';

// Everything below comes from the app's Settings tab. Application variables
// always arrive as strings — `process.env` semantics — so each one is parsed
// back into the type it was declared with, with the manifest default as the
// fallback for a workspace that never touched the setting.
const readNumberSetting = (key: string, fallback: number) => {
  const parsed = Number(getApplicationVariable(key));

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const readBooleanSetting = (key: string, fallback: boolean) => {
  const raw = getApplicationVariable(key);

  return raw === undefined ? fallback : raw === 'true';
};

const POLL_INTERVAL_MS = readNumberSetting('POLL_INTERVAL_SECONDS', 15) * 1000;
const PAGE_SIZE = readNumberSetting('PAGE_SIZE', 50);
const SHOW_TIMELINE_RAIL = readBooleanSetting('SHOW_TIMELINE_RAIL', false);
const SHOW_SEED_BUTTON = readBooleanSetting('SHOW_SEED_BUTTON', false);
const SHOW_ATTACHMENTS = readBooleanSetting('SHOW_ATTACHMENTS', true);
// Links are looked up for the whole page of records, and a record can carry
// several — so they get a wider budget than the page itself.
const LINK_PAGE_SIZE = Math.min(PAGE_SIZE * 4, 200);

const DEFAULT_SCOPE =
  getApplicationVariable('DEFAULT_SCOPE') === 'all' ? 'all' : 'mine';

// The read-state object is written by this very panel, so its own events would
// otherwise show up in the feed as noise about the feed.
const HIDDEN_EVENT_PREFIX = 'feedReadState.';

const ACTION_LABELS: Record<string, string> = {
  created: 'создана',
  updated: 'изменена',
  deleted: 'удалена',
};

// Russian overrides for the standard objects; everything else (including every
// custom object) takes its label from the workspace's own object metadata.
const OBJECT_LABELS: Record<string, string> = {
  person: 'Контакт',
  company: 'Компания',
  opportunity: 'Сделка',
  task: 'Задача',
  note: 'Заметка',
};

// Attaching a note or a task to a record emits `linked-<kind>.<action>`, whose
// target is the record and whose `linkedRecordCachedName` is the note title.
// This is how comments on a record surface in the timeline.
const LINKED_KIND_LABELS: Record<string, string> = {
  note: 'комментарий',
  task: 'задача',
  attachment: 'документ',
};

const SEED_COMPANIES = [
  'Аурум Групп',
  'Лаборатория Света',
  'СтройМонтаж СПб',
  'Технопарк Восток',
] as const;

const SEED_CONTACTS = [
  { firstName: 'Сергей', lastName: 'Ковалёв', jobTitle: 'Главный инженер' },
  { firstName: 'Анна', lastName: 'Реброва', jobTitle: 'Руководитель закупок' },
  { firstName: 'Дмитрий', lastName: 'Лапин', jobTitle: 'Технический директор' },
  { firstName: 'Ольга', lastName: 'Наумова', jobTitle: 'Руководитель проекта' },
] as const;

const SEED_DEALS = [
  'Освещение офиса на Тверской',
  'Поставка светильников для ТЦ «Галерея»',
  'Реконструкция холла, фаза 2',
  'Комплект мебели для переговорных',
] as const;

const SEED_COMMENTS = [
  'Клиент просит смету до пятницы, бюджет до 800 тыс.',
  'Согласовали образцы, ждём подтверждение по срокам поставки.',
  'Перенесли встречу на следующий вторник, готовлю расчёт с монтажом.',
  'Запросили аналог подешевле — подобрать замену по двум позициям.',
] as const;

const SEED_DOCUMENTS = [
  'КП №1042.pdf',
  'Смета_итоговая.xlsx',
  'Техзадание_v3.docx',
  'Спецификация оборудования.pdf',
] as const;

const LINKED_ACTION_LABELS: Record<string, string> = {
  created: 'добавлен',
  updated: 'изменён',
  deleted: 'откреплён',
};

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

type FieldMeta = {
  label: string;
  options?: Record<string, { label: string; color: string }>;
};

const pluralComments = (count: number) => {
  const tail = count % 10;
  const teen = count % 100;

  if (tail === 1 && teen !== 11) {
    return 'комментарий';
  }

  if (tail >= 2 && tail <= 4 && (teen < 12 || teen > 14)) {
    return 'комментария';
  }

  return 'комментариев';
};

const pluralEvents = (count: number) => {
  const tail = count % 10;
  const teen = count % 100;

  if (tail === 1 && teen !== 11) {
    return 'событие';
  }

  if (tail >= 2 && tail <= 4 && (teen < 12 || teen > 14)) {
    return 'события';
  }

  return 'событий';
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

// Attaching a file emits no timeline event at all — verified against a live
// instance. Attachments carry their own `target<Object>Id` and `createdAt`,
// so they are read separately and folded into the feed as synthetic events.
const toAttachmentEvent = (attachment: TimelineRecord): TimelineRecord => ({
  ...attachment,
  id: `attachment-${String(attachment.id)}`,
  name: 'linked-attachment.created',
  happensAt: attachment.createdAt,
  linkedRecordCachedName: attachment.name,
  properties: null,
});

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
    return 'без изменений';
  }

  if (before === '') {
    return `текст добавлен: ${truncate(after)}`;
  }

  if (after === '') {
    return 'текст удалён';
  }

  if (after.startsWith(before)) {
    return `дописано: ${truncate(after.slice(before.length).trim())}`;
  }

  if (before.startsWith(after)) {
    return 'текст сокращён';
  }

  return `переписано: ${truncate(after)}`;
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
    return 'только что';
  }

  if (minutes < 60) {
    return `${minutes} мин`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours} ч`;
  }

  return `${Math.floor(hours / 24)} дн`;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const describeDue = (dueAt: unknown) => {
  if (typeof dueAt !== 'string' || dueAt === '') {
    return { label: 'без срока', overdueDays: 0, sortKey: Number.MAX_SAFE_INTEGER };
  }

  const due = new Date(dueAt).getTime();
  const days = Math.floor((Date.now() - due) / DAY_MS);

  if (days > 0) {
    return { label: `просрочено на ${days} дн`, overdueDays: days, sortKey: due };
  }

  if (days === 0) {
    return { label: 'сегодня', overdueDays: 0, sortKey: due };
  }

  return { label: `через ${-days} дн`, overdueDays: 0, sortKey: due };
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
        // twenty-ui `sky` (#95E0FB) at a whisper — the softest blue in the
        // palette, used only to lift a card under the cursor.
        cardHover: 'rgba(149, 224, 251, 0.07)',
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
        cardHover: 'rgba(149, 224, 251, 0.13)',
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
  const [isSeeding, setIsSeeding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const loadFeed = useCallback(async () => {
    try {
      const client = new RestApiClient();

      const [timeline, attachments] = await Promise.all([
        client.get<{ data?: { timelineActivities?: TimelineRecord[] } }>(
          '/rest/timelineActivities',
          {
            query: {
              limit: PAGE_SIZE,
              depth: 1,
              order_by: 'happensAt[DescNullsLast]',
            },
          },
        ),
        SHOW_ATTACHMENTS
          ? client.get<{ data?: { attachments?: TimelineRecord[] } }>(
              '/rest/attachments',
              {
                query: {
                  limit: PAGE_SIZE,
                  depth: 1,
                  order_by: 'createdAt[DescNullsLast]',
                },
              },
            )
          : Promise.resolve({ data: { attachments: [] } }),
      ]);

      const events = (timeline.data?.timelineActivities ?? []).filter(
        (item) =>
          typeof item.name !== 'string' ||
          !item.name.startsWith(HIDDEN_EVENT_PREFIX),
      );

      setItems(
        [...events, ...(attachments.data?.attachments ?? []).map(toAttachmentEvent)]
          .sort(byHappensAtDesc)
          .slice(0, PAGE_SIZE),
      );
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Custom objects should read as "Доставка", not "dostavka" — the workspace's
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

  const loadTasks = useCallback(async () => {
    try {
      const client = new RestApiClient();

      const [response, editsResponse, targetsResponse] = await Promise.all([
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
        // What the task hangs on — a deal, a company, a contact. Like notes,
        // the to-many link is not expanded on the record itself.
        client.get<{ data?: { taskTargets?: TimelineRecord[] } }>(
          '/rest/taskTargets',
          {
            // The page caps at 200, so newest links first — an old link that
            // falls outside the window simply is not shown.
            query: {
              limit: LINK_PAGE_SIZE,
              depth: 1,
              order_by: 'createdAt[DescNullsLast]',
            },
          },
        ),
      ]);

      setTasks(response.data?.tasks ?? []);
      setTaskEdits(editsResponse.data?.timelineActivities ?? []);
      setTaskTargets(targetsResponse.data?.taskTargets ?? []);
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

      const [notesResponse, editsResponse, targetsResponse] = await Promise.all([
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
        // `note.noteTargets` comes back empty at depth 1 — to-many relations
        // are not expanded — so the links are read separately.
        client.get<{ data?: { noteTargets?: TimelineRecord[] } }>(
          '/rest/noteTargets',
          {
            query: {
              limit: LINK_PAGE_SIZE,
              order_by: 'createdAt[DescNullsLast]',
            },
          },
        ),
      ]);

      setNotes(notesResponse.data?.notes ?? []);
      setNoteEdits(editsResponse.data?.timelineActivities ?? []);
      setNoteTargets(targetsResponse.data?.noteTargets ?? []);
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

  useEffect(() => {
    void loadFeed();
    void loadTasks();
    void loadBuzz();

    const intervalId = setInterval(() => {
      void loadFeed();
      void loadTasks();
      void loadBuzz();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [loadFeed, loadTasks, loadBuzz]);

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

  // Test-data generator: plays out one plausible deal so the feed has a
  // realistic story to render. Intended for the dev workspace — drop this
  // button before shipping the app anywhere real, it writes actual records.
  const seedTestEvents = async () => {
    setIsSeeding(true);

    try {
      const client = new RestApiClient();
      const pick = <T,>(pool: readonly T[], offset: number) =>
        pool[(Math.floor(Date.now() / 1000) + offset) % pool.length];

      const company = pick(SEED_COMPANIES, 0);
      const contact = pick(SEED_CONTACTS, 1);
      const deal = pick(SEED_DEALS, 2);
      const comment = pick(SEED_COMMENTS, 3);
      const document = pick(SEED_DOCUMENTS, 4);

      const createdCompany = await client.post<{
        data?: { createCompany?: { id: string } };
      }>('/rest/companies', { name: company });

      const companyId = createdCompany.data?.createCompany?.id;

      const createdPerson = await client.post<{
        data?: { createPerson?: { id: string } };
      }>('/rest/people', {
        name: { firstName: contact.firstName, lastName: contact.lastName },
        companyId,
      });

      const createdDeal = await client.post<{
        data?: { createOpportunity?: { id: string } };
      }>('/rest/opportunities', { name: deal, companyId });

      const personId = createdPerson.data?.createPerson?.id;
      const dealId = createdDeal.data?.createOpportunity?.id;

      if (personId !== undefined) {
        await client.patch(`/rest/people/${personId}`, {
          jobTitle: contact.jobTitle,
        });
      }

      if (dealId === undefined) {
        await loadFeed();

        return;
      }

      await client.patch(`/rest/opportunities/${dealId}`, { stage: 'MEETING' });

      // A comment in Twenty is a note attached to a record: this emits both
      // `note.created` and `linked-note.created` on the deal.
      const note = await client.post<{
        data?: { createNote?: { id: string } };
      }>('/rest/notes', { title: comment });

      const noteId = note.data?.createNote?.id;

      if (noteId !== undefined) {
        await client.post('/rest/noteTargets', {
          noteId,
          targetOpportunityId: dealId,
        });
      }

      await client.post('/rest/attachments', {
        name: document,
        fullPath: `attachment/${document}`,
        targetOpportunityId: dealId,
      });

      await loadFeed();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsSeeding(false);
    }
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

  // On an enforcing instance the server already scoped the response, so
  // filtering again would only hide records the viewer is entitled to.
  const visibleItems =
    enforcement !== 'server' && scope === 'mine' ? items.filter(isMine) : items;

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
  const groups: FeedGroup[] = [];
  const groupIndex = new Map<string, FeedGroup>();

  for (const item of visibleItems) {
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

  const unreadCount = visibleItems.filter(isUnread).length;
  const unreadGroups = groups.filter((group) => group.items.some(isUnread));
  const readGroups = groups.filter((group) => !group.items.some(isUnread));

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
      objectLabel:
        OBJECT_LABELS[objectNameSingular] ??
        objectLabels[objectNameSingular] ??
        objectNameSingular ??
        'Запись',
      actionLabel:
        linkedKind !== null
          ? `${LINKED_KIND_LABELS[linkedKind] ?? linkedKind} ${LINKED_ACTION_LABELS[action] ?? action}`
          : (ACTION_LABELS[action] ?? action),
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

      {described.changes.map((change) => (
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
      ))}
    </>
  );

  const renderHead = (item: TimelineRecord, unread: boolean) => {
    const described = describe(item);
    const { target, author, objectLabel, actionLabel, objectNameSingular } =
      described;
    const isBroken = target === null;
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
            {isBroken && ' · запись удалена, не открыть'}
          </div>

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
    const [head, ...rest] = group.items;
    const isExpanded = expandedKeys.includes(group.key);

    return (
      <div
        key={group.key}
        style={{
          paddingBottom: '10px',
          borderBottom: SHOW_TIMELINE_RAIL
            ? 'none'
            : `1px solid ${palette.border}`,
          background: unread ? 'transparent' : 'transparent',
        }}
      >
        {renderHead(head, unread)}

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
                ? 'Свернуть'
                : `ещё ${rest.length} ${pluralEvents(rest.length)} по этой записи`}
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
    const title = typeof task.title === 'string' ? task.title : 'Без названия';
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
          margin: '10px 12px',
          border: `1px solid ${
            isCardHovered ? palette.cardHoverBorder : palette.border
          }`,
          borderRadius: '10px',
          background: isCardHovered
            ? palette.cardHover
            : colorScheme === 'dark'
              ? '#1B1B1B'
              : '#FFFFFF',
          overflow: 'hidden',
          transition: 'background 140ms ease, border-color 140ms ease',
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
                  title={`Открыть: ${link.label}`}
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
                    'Открыть задачу',
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
        title="Показать, к какому месту это написано"
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
              {commenter !== '' ? commenter : 'Кто-то'}
            </span>
            <span style={{ fontSize: '0.85rem', color: palette.textLight }}>
              {formatAgo(String(edit.happensAt))}
            </span>
            {parsed.isRewrite && (
              <span style={{ fontSize: '0.85rem', color: palette.textLight }}>
                переписал текст
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
    const title = typeof note.title === 'string' ? note.title : 'Без названия';
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
          margin: '10px 12px',
          border: `1px solid ${
            isCardHovered ? palette.cardHoverBorder : palette.border
          }`,
          borderRadius: '10px',
          background: isCardHovered
            ? palette.cardHover
            : colorScheme === 'dark'
              ? '#1B1B1B'
              : '#FFFFFF',
          overflow: 'hidden',
          transition: 'background 140ms ease, border-color 140ms ease',
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
                {author !== '' ? author : 'Автор неизвестен'}
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
                  'Открыть текст заметки',
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
      ещё {hidden} {pluralComments(hidden)}
    </button>
  );

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
          {view !== 'feed' ? (
            <>
              <button
                type="button"
                onClick={() => setView('feed')}
                title="Вернуться к общей ленте изменений"
                style={{
                  border: 'none',
                  background: 'transparent',
                  padding: 0,
                  fontFamily: 'inherit',
                  fontSize: '0.92rem',
                  fontWeight: 400,
                  color: palette.textLight,
                  cursor: 'pointer',
                }}
              >
                Лента
              </button>
              <span
                style={{ fontSize: '0.92rem', color: palette.textLight }}
              >
                /
              </span>
              <span style={{ fontSize: '0.92rem', fontWeight: 600 }}>
                {view === 'tasks' ? 'Задачи' : 'Buzz'}
              </span>
            </>
          ) : (
            // A left anchor for the toolbar: without it the controls floated
            // against the right edge with nothing to line up against. The
            // panel header above already carries the app name, so this names
            // the section instead of repeating it.
            <span style={{ fontSize: '0.92rem', fontWeight: 600 }}>Лента</span>
          )}
          {view === 'tasks' && overdueTasks.length > 0 && (
            <span
              title={`Просрочено: ${overdueTasks.length}`}
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
              title={`Всего активных задач: ${openTasks.length}`}
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
              label="Прочитано"
              title="Отметить все события прочитанными"
              onClick={() => void markAllAsRead()}
              background={palette.buttonBackground}
              color={palette.textMid}
            />
          )}
        </div>

        <div
          style={{ display: 'flex', gap: '6px', flexShrink: 0, whiteSpace: 'nowrap' }}
        >
          {view === 'feed' && (
            <>
              <ToolbarButton
                label="Buzz"
                title="Заметки команды и комментарии к ним."
                onClick={() => setView('buzz')}
                background={palette.buttonBackground}
                color={palette.textMid}
              />
              <ToolbarButton
                label="Задачи"
                title="Показать открытые задачи: сначала просроченные, дальше по сроку."
                onClick={() => setView('tasks')}
                background={palette.buttonBackground}
                color={palette.textMid}
              />
            </>
          )}

          <span style={{ width: '6px' }} />

          {view === 'buzz' ? (
            // Buzz is the team wall: everyone's notes, always. A personal
            // filter there would contradict what the section is for.
            <></>
          ) : enforcement === 'server' ? (
            <span
              title="Row-level permissions включены на этом инстансе: доступ ограничивает сам Twenty, панель ничего не доотфильтровывает."
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
              Права: сервер
            </span>
          ) : (
            <ToolbarButton
              label="Только мои"
              isActive={scope === 'mine'}
              activeColor={ACCENT_BLUE}
              title={
                scope === 'mine'
                  ? 'Фильтр включён: показано только связанное с вами. Нажмите, чтобы увидеть всё.'
                  : 'Фильтр выключен: показаны все записи, которые вернул сервер. Нажмите, чтобы оставить только свои.'
              }
              onClick={() => setScope(scope === 'mine' ? 'all' : 'mine')}
              background={palette.buttonBackground}
              color={palette.textMid}
            />
          )}

          {SHOW_SEED_BUTTON && (
            <ToolbarButton
              label={isSeeding ? 'Создаю…' : '+ Тестовые события'}
              title="Создаёт контакт, компанию и сделку и меняет каждой по полю. Пишет настоящие записи."
              onClick={() => void seedTestEvents()}
              background={palette.buttonBackground}
              color={palette.textMid}
            />
          )}

        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: '12px' }}>
        {isLoading && (
          <div style={{ padding: '16px', fontSize: '0.92rem', color: palette.textLight }}>
            Загружаю…
          </div>
        )}

        {error !== null && (
          <div style={{ padding: '16px', fontSize: '0.92rem', color: '#D45453' }}>
            Не удалось загрузить ленту: {error}
          </div>
        )}

        {view === 'feed' && !isLoading && error === null && items.length === 0 && (
          <div style={{ padding: '16px', fontSize: '0.92rem', color: palette.textLight }}>
            Пока ничего не происходило. Создайте или измените любую запись —
            событие появится здесь в течение 15 секунд.
          </div>
        )}

        {view === 'feed' && (
          <>
            {unreadGroups.length > 0 &&
              renderSectionHeader('Новое', unreadGroups.length)}
            {unreadGroups.map((group) => renderGroup(group, true))}

            {readGroups.length > 0 &&
              unreadGroups.length > 0 &&
              renderSectionHeader('Ранее', readGroups.length)}
            {readGroups.map((group) => renderGroup(group, false))}
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
                Заметок пока нет.
              </div>
            )}
          </>
        )}

        {view === 'tasks' && (
          <>
            {overdueTasks.length > 0 &&
              renderSectionHeader('Просрочено', overdueTasks.length)}
            {overdueTasks.map(renderTask)}

            {upcomingTasks.length > 0 &&
              renderSectionHeader(
                overdueTasks.length > 0 ? 'По сроку' : 'Ближайшие',
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
                Открытых задач нет.
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
  description: 'Лента изменений workspace на основе стандартного timelineActivity',
  component: ActivityFeed,
});
