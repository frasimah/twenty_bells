import { defineObject, FieldType } from 'twenty-sdk/define';

import {
  FEED_READ_STATE_LAST_SEEN_FIELD_UNIVERSAL_IDENTIFIER,
  FEED_READ_STATE_OBJECT_UNIVERSAL_IDENTIFIER,
  FEED_READ_STATE_USER_FIELD_UNIVERSAL_IDENTIFIER,
} from 'src/constants/universal-identifiers';

// Technical object: one row per user holding the activity feed's "last seen"
// timestamp. The documented `kv` store from twenty-sdk/logic-function does not
// exist in the installed SDK (2.23.0), and the docs themselves offer a store
// object as the alternative. Deliberately kept out of the navigation menu.
export default defineObject({
  universalIdentifier: FEED_READ_STATE_OBJECT_UNIVERSAL_IDENTIFIER,
  nameSingular: 'feedReadState',
  namePlural: 'feedReadStates',
  labelSingular: 'Feed Read State',
  labelPlural: 'Feed Read States',
  description: 'Per-user last seen marker for the activity feed',
  icon: 'IconEye',
  fields: [
    {
      universalIdentifier: FEED_READ_STATE_USER_FIELD_UNIVERSAL_IDENTIFIER,
      name: 'userId',
      type: FieldType.TEXT,
      label: 'User id',
      icon: 'IconUser',
    },
    {
      universalIdentifier: FEED_READ_STATE_LAST_SEEN_FIELD_UNIVERSAL_IDENTIFIER,
      name: 'lastSeenAt',
      type: FieldType.DATE_TIME,
      label: 'Last seen at',
      icon: 'IconClock',
    },
  ],
});
