import { defineCommandMenuItem } from 'twenty-sdk/define';

import {
  ACTIVITY_FEED_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  ACTIVITY_FEED_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/universal-identifiers';

export default defineCommandMenuItem({
  universalIdentifier: ACTIVITY_FEED_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  label: 'The Bell',
  // The SDK marks `icon` deprecated ("ignored in favor of application icon"),
  // but the shipped frontend reads it: `icon: n || "IconHandMove"`. Without it
  // the pinned button renders the default hand.
  icon: 'IconBell',
  shortLabel: 'The Bell',
  isPinned: true,
  availabilityType: 'GLOBAL',
  frontComponentUniversalIdentifier:
    ACTIVITY_FEED_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
});
