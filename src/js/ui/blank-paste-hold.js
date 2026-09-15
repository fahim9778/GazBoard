import { showContextMenu } from './contextmenu.js';
import { installBlankPasteGesture } from './blank-paste-gesture.js';

// Android already installs the same gesture in its native adapter. The helper
// checks the platform marker and stays out of the way there; on desktop/web it
// gives touch and pen users the blank-board equivalent of a mouse right-click.
installBlankPasteGesture({
  getApp: () => window.app,
  showMenu: (app, e) => showContextMenu(app, e)
});
