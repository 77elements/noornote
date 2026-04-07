import { AddonToggleView } from '../AddonToggleView';
import { isWalletBalanceEnabled, setWalletBalanceEnabled } from './index';

export class WalletBalanceAddonView extends AddonToggleView {
  constructor() {
    super({
      id: 'wallet-balance',
      name: 'Wallet Balance',
      description: 'Show your Lightning wallet balance in the sidebar with fiat conversion.',
      toggleEvent: 'wallet-balance:addon-toggle',
      isEnabled: () => isWalletBalanceEnabled(),
      setEnabled: (v) => setWalletBalanceEnabled(v),
    });
  }
}
