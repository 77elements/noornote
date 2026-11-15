/**
 * Focus surface: Messages/DMs (v2).
 *
 * A FocusListDetailSurface wired to the messages domain: the cached list
 * is the classic MessagesView; clicking a conversation swaps the classic
 * ConversationView INSIDE the column — the classic SCC tab system does
 * not exist in the shell. The URL follows along (/messages ↔
 * /messages/:pubkey) without touching the Router's view mounting.
 */

import type { FocusDomainSurface } from './focusDomains';
import { FocusListDetailSurface } from './focusListDetailSurface';

export const messagesSurface = async (): Promise<FocusDomainSurface> => {
  const surface = new FocusListDetailSurface({
    className: 'focus-surface--messages',
    navViewType: 'messages',
    listRoute: '/messages',
    detailRoute: pubkey => `/messages/${pubkey}`,
    createList: async () => {
      const { MessagesView } = await import('../components/views/MessagesView');
      return new MessagesView({
        onOpenConversation: pubkey => void surface.openDetail(pubkey),
      });
    },
    createDetail: async pubkey => {
      const { ConversationView } = await import(
        '../components/views/ConversationView'
      );
      return new ConversationView(pubkey, { onExit: () => surface.back() });
    },
    // The list has no internal scroll — the column scrolls, so the list
    // position survives the list ↔ conversation swap.
    preserveListScroll: true,
  });
  return surface.asSurface();
};
