import { defineApplication } from 'twenty-sdk/define';

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
  // of two.
  //
  // The panel is a narrow side panel and no crop of it is 8:5, so each shot
  // sits whole on a canvas of that ratio — nothing cut off, and no text baked
  // in, since the listing is read in more than one language.
  galleryImages: [
    'public/gallery-1-feed.png',
    'public/gallery-2-tasks.png',
    'public/gallery-3-buzz.png',
  ],
  //
  // No `applicationVariables` on purpose. They would render a Settings tab an
  // admin can edit, and nothing they typed would reach the panel: the host
  // injects the values into front components still encrypted
  // (`enc:v2:<workspace>:<blob>`) and neither twenty-sdk nor twenty-client-sdk
  // decrypts them — verified by printing the raw payload inside the panel. Four
  // switches that silently do nothing are worse than no Settings tab, so the
  // values live in the component as constants until Twenty decrypts them.
});
