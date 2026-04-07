import { AddonToggleView } from '../AddonToggleView';
import { isLiveStreamsPlayerEnabled, setLiveStreamsPlayerEnabled } from './index';

export class LiveStreamsPlayerAddonView extends AddonToggleView {
  constructor() {
    super({
      id: 'live-streams-player',
      name: 'Live Streams Player',
      description:
        'Experimental. When a note references a NIP-53 live stream, play it inline right from the timeline — no need to leave NoorNote. Uses hls.js to decode HLS streams. Large providers like zap.stream are supported out of the box.',
      toggleEvent: 'live-streams-player:addon-toggle',
      isEnabled: () => isLiveStreamsPlayerEnabled(),
      setEnabled: (v) => setLiveStreamsPlayerEnabled(v),
    });
  }
}
