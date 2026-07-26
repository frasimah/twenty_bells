import { defineApplication, FieldType } from 'twenty-sdk/define';

import {
  APP_DESCRIPTION,
  APP_DISPLAY_NAME,
  APPLICATION_UNIVERSAL_IDENTIFIER,
} from 'src/constants/universal-identifiers';

export default defineApplication({
  universalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER,
  displayName: APP_DISPLAY_NAME,
  description: APP_DESCRIPTION,
  author: 'kata',
  category: 'Productivity',
  // The pinned command button ignores its own `icon` (deprecated) and always
  // renders the application icon — so the bell has to live here.
  logo: 'public/logo.svg',
  websiteUrl: 'https://kata.agency',
  emailSupport: 'hello@kata.agency',
  issueReportUrl: 'https://github.com/frasimah/twenty_bells/issues',
  // `aboutDescription` is deliberately absent: without it the marketplace shows
  // the package README from npm, so there is one text to keep current instead
  // of two. `galleryImages` needs real screenshots of the panel — add them to
  // public/ before the first marketplace release.
  //
  // These land on the app's Settings tab, where a workspace admin edits them.
  // They are workspace-wide by design: anything personal (read marker, chosen
  // scope) belongs in the app's own records instead.
  applicationVariables: {
    POLL_INTERVAL_SECONDS: {
      universalIdentifier: '9b1e85a3-e465-4956-bf72-f351cd761d9d',
      description: 'How often the panel refetches events, in seconds',
      type: FieldType.NUMBER,
      value: 30,
    },
    PAGE_SIZE: {
      universalIdentifier: '9d11f000-7213-45ff-9bb2-e3c513522bfd',
      description: 'How many recent records to load at a time',
      type: FieldType.NUMBER,
      value: 50,
    },
    SHOW_ATTACHMENTS: {
      universalIdentifier: 'fc7654f3-3255-4aae-91fd-2396de23a9b1',
      description:
        'Show attached documents. Twenty emits no events for them, so the panel reads them separately',
      type: FieldType.BOOLEAN,
      value: true,
    },
    SHOW_TIMELINE_RAIL: {
      universalIdentifier: '6398ab26-21d9-4f41-87bb-52725e0815b8',
      description: 'Draw the vertical timeline rail with per-event dots',
      type: FieldType.BOOLEAN,
      value: false,
    },
    DEFAULT_SCOPE: {
      universalIdentifier: 'a1dfadfa-cb68-4a10-b499-3321123152a1',
      description: 'What to show when the panel opens',
      type: FieldType.SELECT,
      options: [
        { label: 'Only what relates to me', value: 'mine' },
        { label: 'Every record in the workspace', value: 'all' },
      ],
      value: 'mine',
    },
  },
});
