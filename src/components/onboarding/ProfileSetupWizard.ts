/**
 * ProfileSetupWizard
 * Fullscreen step-by-step wizard for new accounts to set up their profile.
 * Replaces the entire app layout (no sidebar, no 3-column grid).
 * Renders directly into #app with its own fullscreen layout.
 *
 * Steps:
 * 1. Welcome - intro text
 * 2. Username (required) - random suggestions + custom input
 * 3. Avatar (required) - upload or choose from default avatars
 * 4. Bio (optional) - textarea
 * 5. Relays (required) - pre-selected suggestions + custom add
 * 6. Done - summary + publish + go to timeline
 */

import { Router } from '../../services/Router';
import { ProfileEditorService, type ProfileMetadata } from '../../services/ProfileEditorService';
import { AuthService } from '../../services/AuthService';
import { EventBus } from '../../services/EventBus';
import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';
import { ImageUploader } from '../profile/ImageUploader';
import { ToastService } from '../../services/ToastService';
import { RelayListOrchestrator } from '../../services/orchestration/RelayListOrchestrator';
import type { RelayInfo, RelayType } from '../../services/RelayConfig';
import {
  renderUsernameField,
  renderBioField
} from '../../helpers/profile-field-helpers';

interface WizardRelay {
  url: string;
  read: boolean;
  write: boolean;
}

interface WizardInboxRelay {
  url: string;
  selected: boolean;
}

interface WizardStep {
  id: string;
  title: string;
  required: boolean;
  render: () => HTMLElement;
  validate: () => boolean;
  collect: () => void;
}

interface FollowPack {
  id: string;
  eventId: string;
  title: string;
  description: string;
  coverImage: string;
  authorPubkey: string;
  authorName?: string;
  userPubkeys: string[];
  userProfiles?: Map<string, { name?: string; picture?: string; about?: string }>;
}

// Word lists for random username generation
const ADJECTIVES = [
  // Positive & cheerful
  'Happy', 'Bright', 'Lucky', 'Warm', 'Jolly', 'Sunny', 'Lively', 'Cozy',
  'Merry', 'Glad', 'Joyful', 'Cheery', 'Blissful', 'Gleeful', 'Peppy',
  'Upbeat', 'Chipper', 'Breezy', 'Perky', 'Bubbly',
  // Strength & courage
  'Bold', 'Brave', 'Fierce', 'Daring', 'Plucky', 'Mighty', 'Tough',
  'Sturdy', 'Hardy', 'Gritty', 'Fearless', 'Valiant', 'Gallant', 'Rugged',
  'Steely', 'Staunch', 'Stout', 'Ironclad', 'Resolute', 'Undaunted',
  // Speed & agility
  'Swift', 'Nimble', 'Snappy', 'Quick', 'Agile', 'Zippy', 'Fleet',
  'Deft', 'Brisk', 'Sprightly', 'Hasty', 'Rapid', 'Darting', 'Spry',
  'Limber', 'Lithe', 'Bouncy', 'Frisky', 'Loping', 'Scampering',
  // Calm & gentle
  'Calm', 'Gentle', 'Quiet', 'Serene', 'Mellow', 'Steady', 'Humble',
  'Tender', 'Placid', 'Tranquil', 'Docile', 'Meek', 'Soothing', 'Balmy',
  'Hushed', 'Languid', 'Dulcet', 'Velvet', 'Feathery', 'Pillowy',
  // Intelligence & wisdom
  'Wise', 'Clever', 'Keen', 'Witty', 'Lucid', 'Astute', 'Sharp',
  'Crafty', 'Shrewd', 'Savvy', 'Canny', 'Brainy', 'Learned', 'Sage',
  'Studious', 'Curious', 'Pensive', 'Knowing', 'Mindful', 'Thoughtful',
  // Noble & moral
  'Noble', 'Kind', 'Pure', 'Grand', 'Honest', 'Just', 'Fair', 'Loyal',
  'True', 'Gracious', 'Virtuous', 'Devout', 'Earnest', 'Sincere',
  'Worthy', 'Regal', 'Stately', 'Dignified', 'Gallant', 'Courtly',
  // Nature & elemental
  'Wild', 'Free', 'Stormy', 'Frosty', 'Dusty', 'Rustic', 'Mossy',
  'Sandy', 'Rocky', 'Leafy', 'Thorny', 'Woody', 'Muddy', 'Dewy',
  'Ashen', 'Smoky', 'Misty', 'Foggy', 'Windy', 'Rainy',
  // Cosmic & mystical
  'Cosmic', 'Mystic', 'Stellar', 'Lunar', 'Solar', 'Astral', 'Arcane',
  'Ethereal', 'Phantom', 'Spectral', 'Eldritch', 'Fabled', 'Mythic',
  'Enchanted', 'Charmed', 'Haunted', 'Veiled', 'Cloaked', 'Shadowy', 'Twilight',
  // Color & light
  'Golden', 'Silver', 'Crimson', 'Scarlet', 'Azure', 'Amber', 'Ivory',
  'Copper', 'Bronze', 'Onyx', 'Jade', 'Ruby', 'Coral', 'Indigo',
  'Violet', 'Tawny', 'Russet', 'Gilded', 'Opal', 'Pearly',
  // Texture & feel
  'Sleek', 'Crisp', 'Fuzzy', 'Stark', 'Vivid', 'Radiant', 'Glossy',
  'Polished', 'Grainy', 'Woven', 'Braided', 'Carved', 'Frosted', 'Glazed',
  'Burnished', 'Patched', 'Rough', 'Smooth', 'Silky', 'Velvety',
  // Temperature & sensation
  'Cool', 'Zesty', 'Spicy', 'Tangy', 'Bitter', 'Salty', 'Peppery',
  'Toasty', 'Molten', 'Blazing', 'Searing', 'Chilly', 'Frigid', 'Tepid',
  'Scalding', 'Lukewarm', 'Glacial', 'Volcanic', 'Tropical', 'Arctic',
  // Sound & rhythm
  'Loud', 'Humming', 'Ringing', 'Roaring', 'Rumbling', 'Whispering',
  'Chanting', 'Singing', 'Droning', 'Buzzing', 'Clicking', 'Ticking',
  'Rattling', 'Clanking', 'Booming', 'Echoing', 'Lilting', 'Melodic',
  'Harmonic', 'Rhythmic',
  // Size & shape
  'Tiny', 'Vast', 'Narrow', 'Wide', 'Tall', 'Round', 'Angular',
  'Twisted', 'Curved', 'Spiral', 'Jagged', 'Pointed', 'Blunt', 'Hollow',
  'Solid', 'Dense', 'Lean', 'Lanky', 'Squat', 'Bulky',
  // Time & age
  'Ancient', 'Primal', 'Timeless', 'Ageless', 'Vintage', 'Antique',
  'Modern', 'Fresh', 'Nascent', 'Budding', 'Dawning', 'Dusk', 'Eternal',
  'Fleeting', 'Lasting', 'Enduring', 'Bygone', 'Primeval', 'Archaic', 'Newborn',
  // Attitude & mood
  'Sly', 'Coy', 'Wry', 'Smug', 'Sassy', 'Feisty', 'Cheeky', 'Grumpy',
  'Cranky', 'Moody', 'Gloomy', 'Wistful', 'Dreamy', 'Restless', 'Eager',
  'Anxious', 'Defiant', 'Stubborn', 'Rowdy', 'Reckless',
  // Misc evocative
  'Stark', 'Lone', 'Stray', 'Rogue', 'Nomad', 'Vagrant', 'Roaming',
  'Drifting', 'Wandering', 'Wayward', 'Exiled', 'Hidden', 'Secret',
  'Obscure', 'Remote', 'Distant', 'Forgotten', 'Lost', 'Sunken', 'Buried'
];

const NOUNS = [
  // Animals — mammals
  'Falcon', 'Otter', 'Panda', 'Eagle', 'Wolf', 'Dolphin', 'Fox', 'Owl',
  'Bear', 'Hawk', 'Lynx', 'Raven', 'Heron', 'Whale', 'Deer', 'Jaguar',
  'Cobra', 'Parrot', 'Bison', 'Crane', 'Toucan', 'Mantis', 'Badger',
  'Gecko', 'Pelican', 'Moose', 'Osprey', 'Coyote', 'Puffin', 'Condor',
  'Ibis', 'Newt', 'Wombat', 'Ferret', 'Marten', 'Salmon', 'Finch',
  'Beetle', 'Marlin', 'Yak', 'Panther', 'Stallion', 'Gazelle', 'Viper',
  'Scorpion', 'Sparrow', 'Starling', 'Wren', 'Robin', 'Magpie',
  'Albatross', 'Stork', 'Flamingo', 'Chameleon', 'Iguana', 'Armadillo',
  'Hedgehog', 'Squirrel', 'Chipmunk', 'Raccoon', 'Possum', 'Mole',
  'Shrew', 'Lemur', 'Gibbon', 'Macaw', 'Corgi', 'Husky', 'Collie',
  'Mustang', 'Donkey', 'Rooster', 'Goose', 'Swan', 'Pigeon', 'Moth',
  'Cricket', 'Firefly', 'Hornet', 'Wasp', 'Lobster', 'Crab', 'Shrimp',
  'Octopus', 'Squid', 'Stingray', 'Seahorse', 'Walrus', 'Seal', 'Penguin',
  'Turtle', 'Tortoise', 'Toad', 'Frog', 'Lizard', 'Snail', 'Clam',
  'Oyster', 'Eel', 'Pike', 'Trout', 'Perch', 'Bass', 'Carp',
  // Animals — mythical & exotic
  'Phoenix', 'Griffin', 'Dragon', 'Sphinx', 'Hydra', 'Kraken', 'Minotaur',
  'Chimera', 'Basilisk', 'Wyvern', 'Gargoyle', 'Golem', 'Titan',
  'Centaur', 'Cyclops', 'Leviathan', 'Behemoth', 'Unicorn', 'Pegasus', 'Siren',
  // Objects & tools
  'Sailboat', 'Lantern', 'Compass', 'Rocket', 'Anchor', 'Beacon',
  'Zeppelin', 'Prism', 'Pendulum', 'Telescope', 'Windmill', 'Canoe',
  'Gondola', 'Fiddle', 'Hammock', 'Kite', 'Hourglass', 'Trumpet',
  'Cauldron', 'Anvil', 'Satchel', 'Quill', 'Goblet', 'Loom', 'Abacus',
  'Barrel', 'Mortar', 'Chisel', 'Bugle', 'Shuttle', 'Helm', 'Flute',
  'Spindle', 'Wagon', 'Bellows', 'Oar', 'Vessel', 'Drum', 'Wrench',
  'Spool', 'Dagger', 'Shield', 'Banner', 'Pendant', 'Amulet', 'Gauntlet',
  'Chalice', 'Scepter', 'Trident', 'Harpoon', 'Locket', 'Brooch',
  'Buckle', 'Lever', 'Pulley', 'Cog', 'Gear', 'Valve', 'Piston',
  'Turbine', 'Propeller', 'Rudder', 'Saddle', 'Bridle', 'Stirrup',
  'Ladder', 'Pulpit', 'Lectern', 'Easel', 'Canvas', 'Palette', 'Brush',
  'Chisel', 'Hammer', 'Tongs', 'Bellows', 'Crucible', 'Furnace', 'Forge',
  'Kiln', 'Lathe', 'Plough', 'Sickle', 'Scythe', 'Spade', 'Trowel',
  'Pickaxe', 'Lantern', 'Torch', 'Candle', 'Lamp', 'Chandelier',
  'Monocle', 'Spyglass', 'Sextant', 'Astrolabe', 'Sundial', 'Metronome',
  'Tuning', 'Gavel', 'Scroll', 'Tome', 'Codex', 'Atlas', 'Ledger',
  'Inkwell', 'Typewriter', 'Telegraph', 'Phonograph', 'Camera', 'Projector',
  // Vehicles & craft
  'Galleon', 'Frigate', 'Clipper', 'Dinghy', 'Kayak', 'Raft', 'Barge',
  'Trawler', 'Schooner', 'Corvette', 'Biplane', 'Glider', 'Balloon',
  'Capsule', 'Chariot', 'Carriage', 'Sleigh', 'Sled', 'Trolley', 'Boxcar',
  // Nature — land
  'Horizon', 'Comet', 'Breeze', 'Summit', 'River', 'Canyon', 'Glacier',
  'Aurora', 'Meadow', 'Nebula', 'Lagoon', 'Tundra', 'Reef', 'Geyser',
  'Dune', 'Fjord', 'Marsh', 'Crater', 'Torrent', 'Thicket', 'Grove',
  'Ravine', 'Estuary', 'Ridge', 'Basin', 'Delta', 'Savanna', 'Plateau',
  'Cove', 'Steppe', 'Cascade', 'Inlet', 'Bluff', 'Prairie', 'Grotto',
  'Coral', 'Pebble', 'Driftwood', 'Willow', 'Cedar', 'Birch', 'Maple',
  'Cypress', 'Juniper', 'Hemlock', 'Spruce', 'Aspen', 'Sequoia', 'Banyan',
  'Bamboo', 'Fern', 'Thistle', 'Clover', 'Ivy', 'Moss', 'Lichen',
  'Orchid', 'Dahlia', 'Lotus', 'Tulip', 'Iris', 'Poppy', 'Violet',
  'Jasmine', 'Sage', 'Thyme', 'Basil', 'Rosemary', 'Lavender', 'Mint',
  'Bramble', 'Briar', 'Thorn', 'Acorn', 'Pinecone', 'Boulder', 'Cobble',
  'Granite', 'Obsidian', 'Slate', 'Marble', 'Sandstone', 'Limestone',
  'Flint', 'Chalk', 'Clay', 'Loam', 'Humus', 'Silt', 'Gravel',
  // Nature — water & sky
  'Tide', 'Wave', 'Surf', 'Foam', 'Spray', 'Mist', 'Drizzle', 'Downpour',
  'Squall', 'Tempest', 'Cyclone', 'Typhoon', 'Monsoon', 'Blizzard',
  'Hailstone', 'Sleet', 'Thunder', 'Lightning', 'Rainbow', 'Halo',
  'Eclipse', 'Solstice', 'Equinox', 'Twilight', 'Dawn', 'Dusk', 'Sunrise',
  'Sunset', 'Starlight', 'Moonbeam', 'Sunray', 'Cloud', 'Cirrus',
  'Cumulus', 'Stratus', 'Nimbus', 'Vortex', 'Whirlpool', 'Maelstrom',
  'Current', 'Eddy', 'Ripple', 'Spring', 'Brook', 'Creek', 'Stream',
  'Pond', 'Lake', 'Swamp', 'Bog', 'Fen', 'Oasis',
  // Nature — earth & geology
  'Volcano', 'Caldera', 'Cavern', 'Gorge', 'Chasm', 'Abyss', 'Trench',
  'Fault', 'Ledge', 'Cliff', 'Spire', 'Pinnacle', 'Mesa', 'Butte',
  'Outcrop', 'Moraine', 'Glacier', 'Iceberg', 'Permafrost', 'Magma',
  // Space & cosmos
  'Nova', 'Quasar', 'Pulsar', 'Meteor', 'Asteroid', 'Orbit', 'Galaxy',
  'Cosmos', 'Void', 'Rift', 'Warp', 'Flux', 'Photon', 'Proton',
  'Neutron', 'Electron', 'Atom', 'Plasma', 'Spectrum', 'Prism',
  // Abstract — fate & drama
  'Fate', 'Drama', 'Chaos', 'Order', 'Chance', 'Destiny', 'Fortune',
  'Karma', 'Nemesis', 'Paradox', 'Dilemma', 'Crisis', 'Climax', 'Twist',
  'Plot', 'Scheme', 'Gambit', 'Ruse', 'Bluff', 'Wager', 'Stake',
  'Verdict', 'Oath', 'Pledge', 'Vow', 'Decree', 'Edict', 'Mandate',
  'Truce', 'Pact',
  // Abstract — emotions & states
  'Fury', 'Rage', 'Wrath', 'Spite', 'Envy', 'Pride', 'Shame', 'Guilt',
  'Grief', 'Sorrow', 'Bliss', 'Joy', 'Hope', 'Dread', 'Angst',
  'Malice', 'Grace', 'Mercy', 'Valor', 'Honor', 'Glory', 'Virtue',
  'Folly', 'Hubris', 'Guile', 'Cunning', 'Grit', 'Nerve', 'Pluck', 'Zeal',
  // Abstract — thought & concept
  'Spark', 'Echo', 'Drift', 'Ember', 'Frost', 'Riddle', 'Whisper',
  'Mirage', 'Zenith', 'Cadence', 'Mosaic', 'Voyage', 'Flare',
  'Tempo', 'Cipher', 'Saga', 'Fable', 'Rune', 'Odyssey',
  'Verve', 'Lumen', 'Aura', 'Motif', 'Reverie', 'Presto', 'Quartz',
  'Axiom', 'Tangent', 'Theorem', 'Maxim', 'Creed', 'Dogma', 'Canon',
  'Thesis', 'Premise', 'Notion', 'Whim', 'Hunch', 'Inkling', 'Epiphany',
  'Omen', 'Portent', 'Herald', 'Signal', 'Beacon', 'Token', 'Symbol',
  'Emblem', 'Sigil', 'Glyph', 'Cipher', 'Code', 'Key', 'Lock',
  'Puzzle', 'Maze', 'Labyrinth', 'Spiral', 'Loop', 'Knot',
  // Abstract — action & event
  'Clash', 'Surge', 'Burst', 'Rush', 'Dash', 'Leap', 'Plunge', 'Dive',
  'Charge', 'Rally', 'Siege', 'Raid', 'Ambush', 'Heist', 'Quest',
  'Crusade', 'Venture', 'Gamble', 'Hustle', 'Grind', 'Sprint', 'March',
  'Stride', 'Trek', 'Pilgrimage', 'Exodus', 'Revolt', 'Mutiny', 'Coup', 'Uprising',
  // Abstract — time & change
  'Epoch', 'Era', 'Moment', 'Phase', 'Cycle', 'Shift', 'Turn', 'Pivot',
  'Onset', 'Prelude', 'Finale', 'Encore', 'Interlude', 'Overture', 'Crescendo',
  'Requiem', 'Elegy', 'Ballad', 'Anthem', 'Hymn', 'Psalm', 'Sonnet',
  'Verse', 'Stanza', 'Canto', 'Prologue', 'Epilogue', 'Chapter', 'Volume', 'Scroll',
  // Abstract — society & roles
  'Outlaw', 'Rebel', 'Pilgrim', 'Nomad', 'Hermit', 'Wanderer', 'Drifter',
  'Sage', 'Oracle', 'Prophet', 'Mystic', 'Shaman', 'Druid', 'Monk',
  'Knight', 'Squire', 'Baron', 'Duke', 'Earl', 'Marquis', 'Consul',
  'Tribune', 'Envoy', 'Herald', 'Scribe', 'Bard', 'Minstrel', 'Jester',
  'Rogue', 'Bandit',
  // Materials & substances
  'Amber', 'Topaz', 'Garnet', 'Sapphire', 'Emerald', 'Diamond', 'Onyx',
  'Jade', 'Pearl', 'Opal', 'Cobalt', 'Chrome', 'Nickel', 'Zinc',
  'Copper', 'Bronze', 'Brass', 'Iron', 'Steel', 'Titanium', 'Carbon',
  'Silicon', 'Mercury', 'Neon', 'Argon', 'Helium', 'Radium', 'Sulfur',
  'Phosphor', 'Crystal',
  // Food & drink
  'Pepper', 'Ginger', 'Saffron', 'Cinnamon', 'Nutmeg', 'Vanilla', 'Cocoa',
  'Espresso', 'Matcha', 'Chai', 'Mango', 'Papaya', 'Coconut', 'Walnut',
  'Almond', 'Hazel', 'Cashew', 'Pecan', 'Olive', 'Fig',
  // Music & art
  'Riff', 'Chord', 'Note', 'Scale', 'Beat', 'Bass', 'Treble', 'Alto',
  'Tenor', 'Soprano', 'Aria', 'Fugue', 'Opus', 'Sketch', 'Fresco',
  'Mural', 'Etching', 'Collage', 'Montage', 'Tableau',
  // Architecture & places
  'Tower', 'Citadel', 'Bastion', 'Rampart', 'Turret', 'Parapet', 'Vault',
  'Crypt', 'Dungeon', 'Keep', 'Moat', 'Drawbridge', 'Gatehouse', 'Arcade',
  'Colonnade', 'Rotunda', 'Atrium', 'Alcove', 'Balcony', 'Terrace',
  'Pavilion', 'Gazebo', 'Pergola', 'Arbor', 'Courtyard', 'Plaza',
  'Bazaar', 'Harbor', 'Wharf', 'Pier'
];

// DiceBear avatar styles to mix for variety
const DICEBEAR_STYLES = ['adventurer', 'avataaars', 'bottts', 'fun-emoji', 'lorelei', 'micah', 'notionists', 'open-peeps', 'personas', 'pixel-art', 'shapes', 'thumbs'];

function generateAvatarUrl(seed: string, style: string): string {
  return `https://api.dicebear.com/9.x/${style}/svg?seed=${encodeURIComponent(seed)}`;
}

function generateRandomAvatars(count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const seed = `noornote-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`;
    const style = DICEBEAR_STYLES[i % DICEBEAR_STYLES.length]!;
    return generateAvatarUrl(seed, style);
  });
}

// Top relays by user count (online only, source: stats.andotherstuff.org 2026-01-27)
const RELAY_POOL = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://relay.momostr.pink',
  'wss://nos.lol',
  'wss://purplepag.es',
  'wss://nostr.wine',
  'wss://relay.ditto.pub',
  'wss://nostr.mom',
  'wss://offchain.pub',
  'wss://relay.mostr.pub',
];

// NIP-17 DM inbox relays (AUTH-capable, private inbox)
const INBOX_RELAY_POOL: WizardInboxRelay[] = [
  { url: 'wss://noornode.nostr1.com', selected: true },
  { url: 'wss://bitcoinmajlis.nostr1.com', selected: true },
  { url: 'wss://relay.0xchat.com', selected: false },
  { url: 'wss://auth.nostr1.com', selected: false },
];

/** Pick `count` random relays from the pool, all set to read+write */
function pickRandomRelays(count: number): WizardRelay[] {
  const shuffled = [...RELAY_POOL].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count).map(url => ({ url, read: true, write: true }));
}

function generateRandomUsername(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}${noun}`;
}

export class ProfileSetupWizard {
  private router: Router;
  private profileEditorService: ProfileEditorService;
  private authService: AuthService;
  private eventBus: EventBus;
  private storage: PerAccountLocalStorage;

  private steps: WizardStep[] = [];
  private currentStepIndex: number = 0;
  private profileData: Partial<ProfileMetadata> = {};
  private avatarUploader: ImageUploader | null = null;
  private publishing: boolean = false;
  private avatarChoices: string[] = [];
  private selectedRelays: WizardRelay[] = [];
  private inboxRelays: WizardInboxRelay[] = [];
  private followPacks: FollowPack[] = [];
  private followPacksLoaded: boolean = false;
  private followPackView: 'grid' | 'detail' = 'grid';
  private selectedPackIndex: number = -1;
  private followedPubkeys: Set<string> = new Set();

  /** The fullscreen container we inject into #app */
  private container: HTMLElement | null = null;
  /** The original #app content (MainLayout), hidden during wizard */
  private originalAppContent: HTMLElement[] = [];

  constructor() {
    this.router = Router.getInstance();
    this.profileEditorService = ProfileEditorService.getInstance();
    this.authService = AuthService.getInstance();
    this.eventBus = EventBus.getInstance();
    this.storage = PerAccountLocalStorage.getInstance();

    this.steps = [
      this.createWelcomeStep(),
      this.createUsernameStep(),
      this.createAvatarStep(),
      this.createBioStep(),
      this.createRelayStep(),
      this.createInboxRelayStep(),
      this.createFollowPacksStep(),
      this.createLightningStep(),
      this.createDoneStep(),
    ];
  }

  /**
   * Show the wizard fullscreen, hiding the main app layout
   */
  public show(): void {
    const app = document.getElementById('app');
    if (!app) return;

    // Hide all existing app children (MainLayout etc.)
    this.originalAppContent = Array.from(app.children) as HTMLElement[];
    this.originalAppContent.forEach(el => el.style.display = 'none');

    // Create fullscreen wizard container
    this.container = document.createElement('div');
    this.container.className = 'wizard-fullscreen';
    app.appendChild(this.container);

    this.restoreProgress();
    this.renderCurrentStep();
  }

  /**
   * Remove wizard and restore main app layout
   */
  private destroy(): void {
    this.avatarUploader?.cleanup();
    this.avatarUploader = null;

    if (this.container) {
      this.container.remove();
      this.container = null;
    }

    // Restore original app content
    this.originalAppContent.forEach(el => el.style.display = '');
    this.originalAppContent = [];
  }

  private renderCurrentStep(): void {
    if (!this.container) return;

    // Cleanup previous avatar uploader
    this.avatarUploader?.cleanup();
    this.avatarUploader = null;

    const step = this.steps[this.currentStepIndex]!;

    // Build fullscreen layout: logo + content + nav
    this.container.innerHTML = '';

    // Logo
    const logo = document.createElement('div');
    logo.className = 'wizard-logo';
    logo.innerHTML = '<span class="nn-logo">NoorNote</span>';
    this.container.appendChild(logo);

    // Inner content wrapper (max-width centered)
    const inner = document.createElement('div');
    inner.className = 'wizard-inner';

    // Progress indicator
    const progress = this.renderProgress();
    inner.appendChild(progress);

    // Step content
    const content = step.render();
    content.classList.add('wizard-step-content');
    inner.appendChild(content);

    // Navigation (not on Done step)
    if (step.id !== 'done') {
      const nav = this.renderNavigation(step);
      inner.appendChild(nav);
    }

    this.container.appendChild(inner);

    // Setup avatar uploader listeners after DOM insertion
    if (step.id === 'avatar') {
      const avatarUploader = this.avatarUploader as ImageUploader | null;
      if (avatarUploader) {
        const section = this.container.querySelector('.wizard-avatar-upload-section');
        if (section) {
          avatarUploader.setupEventListeners(section as HTMLElement);
        }
      }
    }
  }

  private renderProgress(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'wizard-progress';

    const contentSteps = this.steps.filter(s => s.id !== 'welcome' && s.id !== 'done');
    const currentContentIndex = contentSteps.findIndex(s => s.id === this.steps[this.currentStepIndex]!.id);

    el.innerHTML = contentSteps.map((step, i) => {
      const state = i < currentContentIndex ? 'completed' : i === currentContentIndex ? 'active' : 'upcoming';
      return `<div class="wizard-progress-dot wizard-progress-dot--${state}" title="${step.title}"></div>`;
    }).join('<div class="wizard-progress-line"></div>');

    return el;
  }

  private renderNavigation(step: WizardStep): HTMLElement {
    const nav = document.createElement('div');
    nav.className = 'wizard-nav';

    const isFirst = this.currentStepIndex === 0;
    const isRequired = step.required;
    const showSkip = !isRequired && step.id !== 'welcome';

    const navLeft = document.createElement('div');
    navLeft.className = 'wizard-nav-left';

    // Cancel button — always visible on all steps
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn--large btn--passive';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => this.cancelWizard());
    navLeft.appendChild(cancelBtn);

    if (!isFirst) {
      // Restart button (only show after first step)
      const restartBtn = document.createElement('button');
      restartBtn.className = 'btn btn--large btn--passive';
      restartBtn.textContent = 'Restart';
      restartBtn.addEventListener('click', () => this.restartWizard());
      navLeft.appendChild(restartBtn);

      const prevBtn = document.createElement('button');
      prevBtn.className = 'btn btn--large btn--passive';
      prevBtn.textContent = 'Previous';
      prevBtn.addEventListener('click', () => this.goToPreviousStep());
      navLeft.appendChild(prevBtn);
    }
    nav.appendChild(navLeft);

    const navRight = document.createElement('div');
    navRight.className = 'wizard-nav-right';

    if (showSkip) {
      const skipBtn = document.createElement('button');
      skipBtn.className = 'btn btn--large btn--passive';
      skipBtn.textContent = 'Skip';
      skipBtn.addEventListener('click', () => this.goToNextStep());
      navRight.appendChild(skipBtn);
    }

    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn btn--large';
    nextBtn.textContent = 'Next';
    if (isRequired) nextBtn.disabled = true;
    nextBtn.setAttribute('data-wizard-action', 'next');
    nextBtn.addEventListener('click', () => {
      if (step.validate()) {
        step.collect();
        this.goToNextStep();
      }
    });
    navRight.appendChild(nextBtn);

    nav.appendChild(navRight);

    return nav;
  }

  private goToNextStep(): void {
    const currentStep = this.steps[this.currentStepIndex]!;
    if (currentStep.id !== 'done') {
      currentStep.collect();
    }

    if (this.currentStepIndex < this.steps.length - 1) {
      this.currentStepIndex++;
      this.saveProgress();
      this.renderCurrentStep();
    }
  }

  private goToPreviousStep(): void {
    this.steps[this.currentStepIndex]!.collect();

    if (this.currentStepIndex > 0) {
      this.currentStepIndex--;
      this.saveProgress();
      this.renderCurrentStep();
    }
  }

  // ─── Persistence ──────────────────────────────────────────

  private saveProgress(): void {
    this.storage.set(StorageKeys.WIZARD_PROGRESS, {
      stepIndex: this.currentStepIndex,
      profileData: this.profileData,
      avatarChoices: this.avatarChoices,
      selectedRelays: this.selectedRelays,
      inboxRelays: this.inboxRelays,
      followedPubkeys: [...this.followedPubkeys],
    });
  }

  private restoreProgress(): void {
    const saved = this.storage.get<{
      stepIndex: number;
      profileData: Partial<ProfileMetadata>;
      avatarChoices: string[];
      selectedRelays?: WizardRelay[];
      inboxRelays?: WizardInboxRelay[];
      followedPubkeys?: string[];
    } | null>(StorageKeys.WIZARD_PROGRESS, null);

    if (saved) {
      this.currentStepIndex = saved.stepIndex;
      this.profileData = saved.profileData;
      if (saved.avatarChoices?.length) {
        this.avatarChoices = saved.avatarChoices;
      }
      if (saved.selectedRelays?.length) {
        this.selectedRelays = saved.selectedRelays;
      }
      if (saved.inboxRelays?.length) {
        this.inboxRelays = saved.inboxRelays;
      }
      if (saved.followedPubkeys?.length) {
        this.followedPubkeys = new Set(saved.followedPubkeys);
      }
    } else {
      this.currentStepIndex = 0;
      this.profileData = {};
    }
  }

  private clearProgress(): void {
    this.storage.remove(StorageKeys.WIZARD_PROGRESS);
  }

  private async cancelWizard(): Promise<void> {
    const { ModalService } = await import('../../services/ModalService');
    const modalService = ModalService.getInstance();

    const content = document.createElement('div');
    content.innerHTML = `
      <p>Are you sure? All your inputs and your keypair will be discarded.</p>
      <div style="display: flex; gap: 12px; justify-content: flex-end; margin-top: 24px;">
        <button class="btn btn--passive" data-action="no">No, don't cancel</button>
        <button class="btn" data-action="yes">Yes</button>
      </div>
    `;

    content.querySelector('[data-action="no"]')!.addEventListener('click', () => {
      modalService.hide();
    });

    content.querySelector('[data-action="yes"]')!.addEventListener('click', async () => {
      modalService.hide();

      const pubkey = this.authService.getCurrentUser()?.pubkey;

      // Clear wizard localStorage
      this.clearProgress();
      this.storage.remove(StorageKeys.NEEDS_PROFILE_SETUP);

      // Remove keypair from NoorSigner filesystem
      if (pubkey) {
        try {
          const { hexToNpub } = await import('../../helpers/nip19');
          const npub = hexToNpub(pubkey);
          if (npub) {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('remove_noorsigner_account', { npub });
          }
        } catch (e) {
          console.warn('[ProfileSetupWizard] Failed to remove NoorSigner account files:', e);
        }

        // Remove from localStorage + sign out
        await this.authService.removeStoredAccount(pubkey);

        // Switch to previous account if one exists
        const { AccountStorageService } = await import('../../services/AccountStorageService');
        const accounts = AccountStorageService.getInstance().getAccounts();
        if (accounts.length > 0) {
          await this.authService.switchAccount(accounts[0]!.pubkey);
        }
      }

      this.destroy();
      this.router.navigate('/');
    });

    modalService.show({
      title: 'Cancel Setup',
      content,
      width: '400px',
      height: 'auto',
      closeOnOverlay: true,
      closeOnEsc: true,
    });
  }

  private restartWizard(): void {
    this.clearProgress();
    this.currentStepIndex = 0;
    this.profileData = {};
    this.avatarChoices = [];
    this.selectedRelays = [];
    this.inboxRelays = [];
    this.followPacks = [];
    this.followPacksLoaded = false;
    this.followPackView = 'grid';
    this.selectedPackIndex = -1;
    this.followedPubkeys = new Set();
    this.renderCurrentStep();
  }

  private updateNextButtonState(enabled: boolean): void {
    const btn = document.querySelector('[data-wizard-action="next"]') as HTMLButtonElement;
    if (btn) btn.disabled = !enabled;
  }

  // ─── Step Definitions ──────────────────────────────────────

  private createWelcomeStep(): WizardStep {
    return {
      id: 'welcome',
      title: 'Welcome',
      required: false,
      render: () => {
        const el = document.createElement('div');
        el.innerHTML = `
          <h1>Set Up Your Profile</h1>
          <p class="wizard-intro">
            Let's set up your profile so people can find you on Nostr.
            This only takes a moment.
          </p>
          <p class="wizard-intro">
            Your profile information is published to Nostr relays as a
            <strong>Kind 0</strong> event. You can change it anytime in Settings.
          </p>
        `;
        return el;
      },
      validate: () => true,
      collect: () => {}
    };
  }

  private createUsernameStep(): WizardStep {
    return {
      id: 'username',
      title: 'Username',
      required: true,
      render: () => {
        const el = document.createElement('div');
        this.renderStepHeader(el, 'Choose a Username', 'Your username is how others will find and mention you. Pick one of these or type your own.');

        // Suggestion chips
        const chipsContainer = document.createElement('div');
        chipsContainer.className = 'wizard-username-suggestions';

        const renderChips = () => {
          chipsContainer.innerHTML = '';
          const names = Array.from({ length: 6 }, () => generateRandomUsername());
          names.forEach(name => {
            const chip = document.createElement('button');
            chip.className = 'wizard-suggestion-chip';
            chip.textContent = name;
            chip.addEventListener('click', () => {
              const input = this.container?.querySelector('#name') as HTMLInputElement;
              if (input) {
                input.value = name;
                input.dispatchEvent(new Event('input'));
              }
              chipsContainer.querySelectorAll('.wizard-suggestion-chip').forEach(c => c.classList.remove('active'));
              chip.classList.add('active');
            });
            chipsContainer.appendChild(chip);
          });
        };
        renderChips();
        el.appendChild(chipsContainer);

        // Suggest more button
        const suggestBtn = document.createElement('button');
        suggestBtn.className = 'btn btn--passive wizard-username-regenerate';
        suggestBtn.textContent = 'Suggest more usernames';
        suggestBtn.addEventListener('click', () => renderChips());
        el.appendChild(suggestBtn);

        // Username field
        const usernameField = renderUsernameField(this.profileData.name || '');
        el.appendChild(usernameField);

        // Listen for input to enable/disable Next
        setTimeout(() => {
          const input = this.container?.querySelector('#name') as HTMLInputElement;
          if (input) {
            input.addEventListener('input', () => {
              this.updateNextButtonState(input.value.trim().length > 0);
              chipsContainer.querySelectorAll('.wizard-suggestion-chip').forEach(c => c.classList.remove('active'));
            });
            this.updateNextButtonState(input.value.trim().length > 0);
          }
        }, 0);

        return el;
      },
      validate: () => {
        const input = this.container?.querySelector('#name') as HTMLInputElement;
        return !!input && input.value.trim().length > 0;
      },
      collect: () => {
        const nameInput = this.container?.querySelector('#name') as HTMLInputElement;
        if (nameInput) this.profileData.name = nameInput.value.trim();
      }
    };
  }

  private createAvatarStep(): WizardStep {
    return {
      id: 'avatar',
      title: 'Avatar',
      required: true,
      render: () => {
        const el = document.createElement('div');
        this.renderStepHeader(el, 'Add a Profile Picture', 'Upload your own or choose one below.');

        // Upload section
        const uploadSection = document.createElement('div');
        uploadSection.className = 'wizard-avatar-upload-section';

        this.avatarUploader = new ImageUploader({
          ...(this.profileData.picture && { currentUrl: this.profileData.picture }),
          onUploadSuccess: (url) => {
            this.profileData.picture = url;
            this.updateNextButtonState(true);
            this.container?.querySelectorAll('.wizard-default-avatar').forEach(a => a.classList.remove('active'));
          },
          mediaType: 'avatar',
          className: 'wizard-avatar-uploader'
        });

        uploadSection.innerHTML = this.avatarUploader.render();
        el.appendChild(uploadSection);

        const divider = document.createElement('div');
        divider.className = 'auth-divider';
        divider.innerHTML = '<span>or choose one</span>';
        el.appendChild(divider);

        // DiceBear avatar grid
        if (this.avatarChoices.length === 0) {
          this.avatarChoices = generateRandomAvatars(8);
        }

        const grid = document.createElement('div');
        grid.className = 'wizard-avatar-grid';
        this.renderAvatarGrid(grid);
        el.appendChild(grid);

        // Regenerate button
        const regenBtn = document.createElement('button');
        regenBtn.className = 'btn btn--passive wizard-avatar-regenerate';
        regenBtn.textContent = 'Show different avatars';
        regenBtn.addEventListener('click', () => {
          this.avatarChoices = generateRandomAvatars(8);
          this.renderAvatarGrid(grid);
        });
        el.appendChild(regenBtn);

        setTimeout(() => {
          this.updateNextButtonState(!!this.profileData.picture);
        }, 0);

        return el;
      },
      validate: () => !!this.profileData.picture,
      collect: () => {}
    };
  }

  private renderAvatarGrid(grid: HTMLElement): void {
    grid.innerHTML = '';
    this.avatarChoices.forEach(url => {
      const avatarBtn = document.createElement('button');
      avatarBtn.className = 'wizard-default-avatar';
      if (this.profileData.picture === url) avatarBtn.classList.add('active');
      avatarBtn.innerHTML = `<img src="${url}" alt="Avatar" />`;
      avatarBtn.addEventListener('click', () => {
        this.profileData.picture = url;
        this.updateNextButtonState(true);
        grid.querySelectorAll('.wizard-default-avatar').forEach(a => a.classList.remove('active'));
        avatarBtn.classList.add('active');
        // Update uploader preview
        const preview = this.container?.querySelector('.wizard-avatar-upload-section [data-preview]') as HTMLElement;
        if (preview) preview.style.backgroundImage = `url('${url}')`;
      });
      grid.appendChild(avatarBtn);
    });
  }

  private createBioStep(): WizardStep {
    return {
      id: 'bio',
      title: 'Bio',
      required: false,
      render: () => {
        const el = document.createElement('div');
        this.renderStepHeader(el, 'Tell Us About Yourself', 'A short bio helps others get to know you. You can always change this later.');

        const bioField = renderBioField(this.profileData.about || '');
        el.appendChild(bioField);

        return el;
      },
      validate: () => true,
      collect: () => {
        const textarea = this.container?.querySelector('#about') as HTMLTextAreaElement;
        if (textarea) this.profileData.about = textarea.value.trim();
      }
    };
  }

  private createRelayStep(): WizardStep {
    return {
      id: 'relays',
      title: 'Relays',
      required: true,
      render: () => {
        // Initialize with 3 random relays if empty
        if (this.selectedRelays.length === 0) {
          this.selectedRelays = pickRandomRelays(3);
        }

        const el = document.createElement('div');
        this.renderStepHeader(el, 'Choose Your Relays', 'Relays are servers that store and share your posts. We\'ve picked a few reliable ones to get you started. You can change these anytime in Settings.');

        // Relay list
        const relayList = document.createElement('div');
        relayList.className = 'wizard-relay-list';
        this.renderRelayList(relayList);
        el.appendChild(relayList);

        // Add custom relay
        const addRow = document.createElement('div');
        addRow.className = 'wizard-relay-add';
        addRow.innerHTML = `
          <input type="text" class="input" id="wizard-relay-custom" placeholder="wss://relay.example.com" />
          <button class="btn btn--passive" data-action="add-relay">Add</button>
        `;
        el.appendChild(addRow);

        // Add relay handler
        const addRelay = () => {
          const input = el.querySelector('#wizard-relay-custom') as HTMLInputElement;
          const url = input?.value.trim();
          if (!url) return;

          // Validate wss:// or ws:// URL
          if (!url.startsWith('wss://') && !url.startsWith('ws://')) {
            ToastService.show('Relay URL must start with wss:// or ws://', 'error');
            return;
          }

          // Check duplicate
          if (this.selectedRelays.some(r => r.url === url)) {
            ToastService.show('Relay already added', 'error');
            return;
          }

          this.selectedRelays.push({ url, read: true, write: true });
          input.value = '';
          this.renderRelayList(relayList);
          this.updateNextButtonState(this.selectedRelays.length > 0);
        };

        addRow.querySelector('[data-action="add-relay"]')?.addEventListener('click', addRelay);
        addRow.querySelector('#wizard-relay-custom')?.addEventListener('keydown', (e) => {
          if ((e as KeyboardEvent).key === 'Enter') addRelay();
        });

        // Suggest more button
        const suggestBtn = document.createElement('button');
        suggestBtn.className = 'btn btn--passive wizard-relay-suggest';
        suggestBtn.textContent = 'Suggest different relays';
        suggestBtn.addEventListener('click', () => {
          this.selectedRelays = pickRandomRelays(3);
          this.renderRelayList(relayList);
          this.updateNextButtonState(true);
        });
        el.appendChild(suggestBtn);

        setTimeout(() => {
          this.updateNextButtonState(this.selectedRelays.length > 0);
        }, 0);

        return el;
      },
      validate: () => this.selectedRelays.length > 0,
      collect: () => {}
    };
  }

  private renderRelayList(container: HTMLElement): void {
    container.innerHTML = '';

    this.selectedRelays.forEach((relay, index) => {
      const row = document.createElement('div');
      row.className = 'wizard-relay-row';

      row.innerHTML = `
        <div class="wizard-relay-url">${this.escapeHtml(relay.url.replace('wss://', ''))}</div>
        <div class="wizard-relay-toggles">
          <label class="wizard-relay-toggle">
            <input type="checkbox" data-relay-index="${index}" data-type="read" ${relay.read ? 'checked' : ''} />
            <span>Read</span>
          </label>
          <label class="wizard-relay-toggle">
            <input type="checkbox" data-relay-index="${index}" data-type="write" ${relay.write ? 'checked' : ''} />
            <span>Write</span>
          </label>
        </div>
        <button class="wizard-relay-remove" data-remove-index="${index}" title="Remove">&times;</button>
      `;

      // Toggle handlers
      row.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', (e) => {
          const target = e.target as HTMLInputElement;
          const idx = parseInt(target.dataset.relayIndex!);
          const type = target.dataset.type as 'read' | 'write';
          this.selectedRelays[idx]![type] = target.checked;
        });
      });

      // Remove handler
      row.querySelector('.wizard-relay-remove')?.addEventListener('click', () => {
        this.selectedRelays.splice(index, 1);
        this.renderRelayList(container);
        this.updateNextButtonState(this.selectedRelays.length > 0);
      });

      container.appendChild(row);
    });
  }

  private createInboxRelayStep(): WizardStep {
    return {
      id: 'inbox-relays',
      title: 'DM Inbox',
      required: true,
      render: () => {
        // Initialize inbox relays from pool if empty
        if (this.inboxRelays.length === 0) {
          this.inboxRelays = INBOX_RELAY_POOL.map(r => ({ ...r }));
        }

        const el = document.createElement('div');
        this.renderStepHeader(el, 'DM Inbox Relays', 'These relays receive your private messages. Pick at least 2 for reliability. Only you can read messages delivered here.');

        const inboxList = document.createElement('div');
        inboxList.className = 'wizard-inbox-relay-list';
        this.renderInboxRelayList(inboxList);
        el.appendChild(inboxList);

        setTimeout(() => {
          const count = this.inboxRelays.filter(r => r.selected).length;
          this.updateNextButtonState(count >= 2);
        }, 0);

        return el;
      },
      validate: () => this.inboxRelays.filter(r => r.selected).length >= 2,
      collect: () => {}
    };
  }

  private renderInboxRelayList(container: HTMLElement): void {
    container.innerHTML = '';

    this.inboxRelays.forEach((relay, index) => {
      const row = document.createElement('div');
      row.className = `wizard-relay-row${relay.selected ? ' wizard-relay-row--selected' : ''}`;

      row.innerHTML = `
        <label class="wizard-inbox-relay-label">
          <input type="checkbox" data-inbox-index="${index}" ${relay.selected ? 'checked' : ''} />
          <span class="wizard-relay-url">${this.escapeHtml(relay.url.replace('wss://', ''))}</span>
        </label>
      `;

      row.querySelector('input[type="checkbox"]')?.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;
        this.inboxRelays[index]!.selected = target.checked;
        row.classList.toggle('wizard-relay-row--selected', target.checked);
        const selectedCount = this.inboxRelays.filter(r => r.selected).length;
        this.updateNextButtonState(selectedCount >= 2);
      });

      container.appendChild(row);
    });
  }

  // ─── Follow Packs Step ──────────────────────────────────────

  private createFollowPacksStep(): WizardStep {
    return {
      id: 'follow-packs',
      title: 'Follow',
      required: false,
      render: () => {
        const el = document.createElement('div');
        el.className = 'wizard-follow-packs';

        if (this.followPackView === 'detail' && this.selectedPackIndex >= 0) {
          this.renderPackDetail(el);
        } else {
          this.renderPackGrid(el);
        }

        return el;
      },
      validate: () => true,
      collect: () => {}
    };
  }

  private renderPackGrid(el: HTMLElement): void {
    const heading = document.createElement('h2');
    heading.textContent = 'Find People to Follow';
    el.appendChild(heading);

    const intro = document.createElement('p');
    intro.className = 'wizard-intro';
    intro.textContent = 'Time to fill your timeline with interesting content. Browse the packs below and follow the people that interest you.';
    el.appendChild(intro);

    const subIntro = document.createElement('p');
    subIntro.className = 'wizard-intro';
    subIntro.innerHTML = '<em>This is just a start, you\'ll discover more accounts over time.</em>';
    el.appendChild(subIntro);

    if (this.followedPubkeys.size > 0) {
      const badge = document.createElement('p');
      badge.className = 'wizard-follow-count';
      badge.textContent = `Following ${this.followedPubkeys.size} account${this.followedPubkeys.size !== 1 ? 's' : ''}`;
      el.appendChild(badge);
    }

    const grid = document.createElement('div');
    grid.className = 'wizard-pack-grid';

    if (!this.followPacksLoaded) {
      grid.innerHTML = '<p class="wizard-intro">Loading follow packs...</p>';
      el.appendChild(grid);
      this.fetchFollowPacks().then(() => {
        this.renderPackCards(grid);
      });
    } else {
      this.renderPackCards(grid);
      el.appendChild(grid);
    }

    const credit = document.createElement('p');
    credit.className = 'small';
    credit.innerHTML = 'Follow Packs by <a href="https://github.com/callebtc/following.space" target="_blank" rel="noopener">calle\'s following.space</a>';
    el.appendChild(credit);
  }

  private renderPackCards(grid: HTMLElement): void {
    grid.innerHTML = '';

    if (this.followPacks.length === 0) {
      grid.innerHTML = '<p class="wizard-intro">No follow packs found. You can skip this step and find people later.</p>';
      return;
    }

    this.followPacks.forEach((pack, index) => {
      const card = document.createElement('div');
      card.className = 'wizard-pack-card';
      card.addEventListener('click', () => {
        this.followPackView = 'detail';
        this.selectedPackIndex = index;
        this.renderCurrentStep();
        // Load profiles for this pack
        this.loadPackProfiles(index);
      });

      const coverDiv = document.createElement('div');
      coverDiv.className = 'wizard-pack-cover';
      if (pack.coverImage) {
        coverDiv.style.backgroundImage = `url('${pack.coverImage}')`;
      }
      card.appendChild(coverDiv);

      const info = document.createElement('div');
      info.className = 'wizard-pack-info';
      info.innerHTML = `
        <div class="wizard-pack-title">${this.escapeHtml(pack.title)}</div>
        <div class="wizard-pack-meta">${pack.userPubkeys.length} users</div>
      `;
      card.appendChild(info);

      grid.appendChild(card);
    });
  }

  private renderPackDetail(el: HTMLElement): void {
    const pack = this.followPacks[this.selectedPackIndex];
    if (!pack) return;

    // Back button
    const backBtn = document.createElement('button');
    backBtn.className = 'btn btn--passive';
    backBtn.textContent = 'Back to packs';
    backBtn.addEventListener('click', () => {
      this.followPackView = 'grid';
      this.selectedPackIndex = -1;
      this.renderCurrentStep();
    });
    el.appendChild(backBtn);

    // Cover
    if (pack.coverImage) {
      const cover = document.createElement('div');
      cover.className = 'wizard-pack-detail-cover';
      cover.style.backgroundImage = `url('${pack.coverImage}')`;
      el.appendChild(cover);
    }

    // Title + description
    const header = document.createElement('div');
    header.className = 'wizard-pack-detail-header';
    header.innerHTML = `
      <h2>${this.escapeHtml(pack.title)}</h2>
      ${pack.description ? `<p class="wizard-intro">${this.escapeHtml(pack.description)}</p>` : ''}
    `;
    el.appendChild(header);

    // Follow All button
    const allFollowed = pack.userPubkeys.every(pk => this.followedPubkeys.has(pk));
    const followAllBtn = document.createElement('button');
    followAllBtn.className = `btn btn--large ${allFollowed ? 'btn--passive' : ''}`;
    followAllBtn.textContent = allFollowed ? 'Following All' : `Follow All (${pack.userPubkeys.length})`;
    if (!allFollowed) {
      followAllBtn.addEventListener('click', () => {
        pack.userPubkeys.forEach(pk => this.followedPubkeys.add(pk));
        this.renderCurrentStep();
        this.loadPackProfiles(this.selectedPackIndex);
      });
    }
    el.appendChild(followAllBtn);

    // User list
    const userList = document.createElement('div');
    userList.className = 'wizard-pack-user-list';

    pack.userPubkeys.forEach(pubkey => {
      const profile = pack.userProfiles?.get(pubkey);
      const isFollowed = this.followedPubkeys.has(pubkey);

      const row = document.createElement('div');
      row.className = 'wizard-pack-user-row';

      const avatar = document.createElement('div');
      avatar.className = 'wizard-pack-user-avatar';
      if (profile?.picture) {
        avatar.style.backgroundImage = `url('${profile.picture}')`;
      }
      row.appendChild(avatar);

      const info = document.createElement('div');
      info.className = 'wizard-pack-user-info';
      info.innerHTML = `
        <div class="wizard-pack-user-name">${this.escapeHtml(profile?.name || pubkey.slice(0, 12) + '...')}</div>
        ${profile?.about ? `<div class="wizard-pack-user-bio">${this.escapeHtml(profile.about.slice(0, 120))}${profile.about.length > 120 ? '...' : ''}</div>` : ''}
      `;
      row.appendChild(info);

      const followBtn = document.createElement('button');
      followBtn.className = `btn btn--small ${isFollowed ? 'btn--passive' : ''}`;
      followBtn.textContent = isFollowed ? 'Following' : 'Follow';
      followBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isFollowed) {
          this.followedPubkeys.delete(pubkey);
        } else {
          this.followedPubkeys.add(pubkey);
        }
        this.renderCurrentStep();
        this.loadPackProfiles(this.selectedPackIndex);
      });
      row.appendChild(followBtn);

      userList.appendChild(row);
    });

    el.appendChild(userList);
  }

  private async fetchFollowPacks(): Promise<void> {
    try {
      const { NostrTransport } = await import('../../services/transport/NostrTransport');
      const { RelayConfig } = await import('../../services/RelayConfig');
      const transport = NostrTransport.getInstance();
      const relays = RelayConfig.getInstance().getAggregatorRelays();

      const events = await transport.fetch(relays, [{ kinds: [39089 as any], limit: 50 }], 8000);

      this.followPacks = events
        .map(event => this.parseFollowPackEvent(event))
        .filter(pack => {
          // Filter out spam packs and empty packs
          const title = pack.title.toLowerCase();
          return !title.includes('spam') && pack.userPubkeys.length > 0 && pack.title.length > 0;
        })
        .sort((a, b) => b.userPubkeys.length - a.userPubkeys.length); // Sort by user count

      this.followPacksLoaded = true;
    } catch {
      this.followPacksLoaded = true;
      this.followPacks = [];
    }
  }

  private parseFollowPackEvent(event: any): FollowPack {
    const tags = event.tags || [];
    const getTag = (name: string) => tags.find((t: string[]) => t[0] === name)?.[1] || '';

    return {
      id: getTag('d'),
      eventId: event.id || '',
      title: getTag('title') || getTag('n') || 'Untitled',
      description: getTag('description') || '',
      coverImage: getTag('image') || '',
      authorPubkey: event.pubkey || '',
      userPubkeys: tags.filter((t: string[]) => t[0] === 'p' && t[1]).map((t: string[]) => t[1]!),
    };
  }

  private async loadPackProfiles(packIndex: number): Promise<void> {
    const pack = this.followPacks[packIndex];
    if (!pack || pack.userProfiles) return;

    try {
      const { UserProfileService } = await import('../../services/UserProfileService');
      const profileService = UserProfileService.getInstance();
      const profiles = await profileService.getUserProfiles(pack.userPubkeys);

      pack.userProfiles = new Map();
      profiles.forEach((profile, pubkey) => {
        const entry: { name?: string; picture?: string; about?: string } = {};
        const displayName = profile.name || profile.display_name || profile.username;
        if (displayName) entry.name = displayName;
        if (profile.picture) entry.picture = profile.picture;
        if (profile.about) entry.about = profile.about;
        pack.userProfiles!.set(pubkey, entry);
      });

      // Re-render if still viewing this pack
      if (this.followPackView === 'detail' && this.selectedPackIndex === packIndex) {
        this.renderCurrentStep();
      }
    } catch {
      // Profiles failed to load — that's okay, show pubkeys
    }
  }

  // ─── Lightning Step ──────────────────────────────────────

  private createLightningStep(): WizardStep {
    let redeemInProgress = false;

    return {
      id: 'lightning',
      title: 'Wallet',
      required: false,
      render: () => {
        const el = document.createElement('div');
        this.renderStepHeader(el, 'Lightning Wallet', 'Set up a Lightning wallet to send and receive Bitcoin tips (Zaps) on Nostr. This is optional, you can set it up later in Settings.');

        // Already configured?
        if (this.profileData.lud16) {
          const done = document.createElement('div');
          done.className = 'wizard-lightning-done';
          done.innerHTML = `
            <p class="wizard-intro">Lightning address configured: <strong>${this.escapeHtml(this.profileData.lud16)}</strong></p>
          `;
          el.appendChild(done);
          return el;
        }

        // Step 1: Open Rizful
        const openSection = document.createElement('div');
        openSection.className = 'wizard-lightning-section';
        openSection.innerHTML = `
          <p><strong>How it works:</strong></p>
          <ul class="wizard-lightning-steps">
            <li>Click the button below to open Rizful in your browser</li>
            <li>Register a free account (email + password)</li>
            <li>Verify your email by clicking the link Rizful sends you</li>
            <li>Come back here and click the button again to get your one-time code</li>
            <li>Copy the code, paste it below and press "Connect"</li>
          </ul>
          <button class="btn btn--large" data-action="open-rizful">Open Rizful</button>
        `;
        el.appendChild(openSection);

        openSection.querySelector('[data-action="open-rizful"]')?.addEventListener('click', async () => {
          try {
            const { PlatformService } = await import('../../services/PlatformService');
            if (PlatformService.getInstance().isTauri) {
              const { open } = await import('@tauri-apps/plugin-shell');
              await open('https://rizful.com/nostr_onboarding_auth_token/get_token');
            } else {
              window.open('https://rizful.com/nostr_onboarding_auth_token/get_token', '_blank', 'noopener,noreferrer');
            }
          } catch {
            ToastService.show('Could not open browser', 'error');
          }
        });

        // Step 2: Enter code
        const codeSection = document.createElement('div');
        codeSection.className = 'wizard-lightning-section';
        codeSection.innerHTML = `
          <p><strong>Step 2:</strong> Paste your one-time code from Rizful below.</p>
          <div class="wizard-relay-add">
            <input type="text" class="input" id="wizard-rizful-code" placeholder="Paste one-time code" />
            <button class="btn" data-action="redeem-code">Connect</button>
          </div>
          <div class="wizard-lightning-status" data-lightning-status></div>
        `;
        el.appendChild(codeSection);

        const redeemBtn = codeSection.querySelector('[data-action="redeem-code"]') as HTMLButtonElement;
        const statusEl = codeSection.querySelector('[data-lightning-status]') as HTMLElement;

        redeemBtn?.addEventListener('click', async () => {
          if (redeemInProgress) return;

          const codeInput = codeSection.querySelector('#wizard-rizful-code') as HTMLInputElement;
          const code = codeInput?.value.trim();
          if (!code) {
            ToastService.show('Please enter a code', 'error');
            return;
          }

          const user = this.authService.getCurrentUser();
          if (!user) {
            ToastService.show('Not logged in', 'error');
            return;
          }

          redeemInProgress = true;
          redeemBtn.disabled = true;
          redeemBtn.textContent = 'Connecting...';
          statusEl.textContent = '';

          try {
            const response = await fetch('https://rizful.com/nostr_onboarding_auth_token/post_for_secrets', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                secret_code: code,
                nostr_public_key: user.pubkey,
              }),
            });

            if (!response.ok) {
              throw new Error(`Request failed (${response.status})`);
            }

            const data = await response.json() as {
              nwc_uri: string;
              lightning_address: string;
              nostr_public_key: string;
            };

            // Save NWC URI via NWCService
            const { NWCService } = await import('../../services/NWCService');
            const nwcService = NWCService.getInstance();
            await nwcService.connect(data.nwc_uri);

            // Set lud16 in profile data
            this.profileData.lud16 = data.lightning_address;

            statusEl.innerHTML = `Connected! Your Lightning address: <strong>${this.escapeHtml(data.lightning_address)}</strong>`;
            statusEl.classList.add('wizard-lightning-status--success');

            ToastService.show('Lightning wallet connected!', 'success');
          } catch (error) {
            statusEl.textContent = `Failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
            statusEl.classList.add('wizard-lightning-status--error');
            redeemBtn.disabled = false;
            redeemBtn.textContent = 'Connect';
          } finally {
            redeemInProgress = false;
          }
        });

        return el;
      },
      validate: () => true,
      collect: () => {}
    };
  }

  private createDoneStep(): WizardStep {
    return {
      id: 'done',
      title: 'Done',
      required: false,
      render: () => {
        const el = document.createElement('div');
        el.className = 'wizard-done';

        el.innerHTML = `
          <h1>You're All Set!</h1>
          <div class="wizard-done-preview">
            <div class="wizard-done-avatar" style="background-image: url('${this.profileData.picture || ''}')"></div>
            <h3>${this.escapeHtml(this.profileData.name || '')}</h3>
            <p class="wizard-done-username">@${this.escapeHtml(this.profileData.name || '')}</p>
            ${this.profileData.about ? `<p class="wizard-done-bio">${this.escapeHtml(this.profileData.about)}</p>` : ''}
            <p class="wizard-done-bio">${this.selectedRelays.length} relay${this.selectedRelays.length !== 1 ? 's' : ''}, ${this.inboxRelays.filter(r => r.selected).length} inbox relay${this.inboxRelays.filter(r => r.selected).length !== 1 ? 's' : ''}</p>
            ${this.followedPubkeys.size > 0 ? `<p class="wizard-done-bio">Following ${this.followedPubkeys.size} account${this.followedPubkeys.size !== 1 ? 's' : ''}</p>` : ''}
            ${this.profileData.lud16 ? `<p class="wizard-done-bio">⚡ ${this.escapeHtml(this.profileData.lud16)}</p>` : ''}
          </div>
          <div class="wizard-nav" style="border-top: none;">
            <button class="btn btn--large btn--passive" data-wizard-action="prev">Previous</button>
            <button class="btn btn--large" data-wizard-action="finish"${this.publishing ? ' disabled' : ''}>
              <span data-finish-text>Save & Go to Timeline</span>
              <span data-finish-spinner style="display: none;">Publishing...</span>
            </button>
          </div>
        `;

        el.querySelector('[data-wizard-action="prev"]')?.addEventListener('click', () => this.goToPreviousStep());
        el.querySelector('[data-wizard-action="finish"]')?.addEventListener('click', () => this.handleFinish());

        return el;
      },
      validate: () => true,
      collect: () => {}
    };
  }

  // ─── Publish & Finish ──────────────────────────────────────

  private async handleFinish(): Promise<void> {
    if (this.publishing) return;
    this.publishing = true;

    const finishBtn = this.container?.querySelector('[data-wizard-action="finish"]') as HTMLButtonElement;
    const finishText = this.container?.querySelector('[data-finish-text]') as HTMLElement;
    const finishSpinner = this.container?.querySelector('[data-finish-spinner]') as HTMLElement;

    if (finishBtn) finishBtn.disabled = true;
    if (finishText) finishText.style.display = 'none';
    if (finishSpinner) finishSpinner.style.display = 'inline';

    try {
      // 1. Publish profile (Kind-0)
      this.updateFinishStatus(finishSpinner, 'Publishing profile...');
      const result = await this.profileEditorService.updateProfile(this.profileData);
      if (!result) {
        this.resetFinishButton(finishBtn, finishText, finishSpinner);
        return;
      }

      // 2. Publish relay list (Kind-10002)
      this.updateFinishStatus(finishSpinner, 'Setting up relays...');
      await this.publishRelayList();

      // 3. Publish DM inbox relay list (Kind-10050)
      this.updateFinishStatus(finishSpinner, 'Setting up DM inbox...');
      await this.publishInboxRelayList();

      // 4. Apply follows
      if (this.followedPubkeys.size > 0) {
        this.updateFinishStatus(finishSpinner, `Following ${this.followedPubkeys.size} accounts...`);
        const { followUser } = await import('../../lists/follows');
        this.followedPubkeys.forEach(pubkey => followUser(pubkey, false));
      }

      // Done
      this.eventBus.emit('profile:updated', {
        pubkey: this.authService.getCurrentUser()?.pubkey
      });

      this.storage.remove(StorageKeys.NEEDS_PROFILE_SETUP);
      this.clearProgress();

      ToastService.show('Profile published!', 'success');

      this.destroy();
      this.router.navigate('/');
    } catch (error) {
      ToastService.show(`Failed to publish: ${error}`, 'error');
      this.resetFinishButton(finishBtn, finishText, finishSpinner);
    }
  }

  private updateFinishStatus(spinner: HTMLElement | null, text: string): void {
    if (spinner) spinner.textContent = text;
  }

  private async publishRelayList(): Promise<void> {
    if (this.selectedRelays.length === 0) return;

    const user = this.authService.getCurrentUser();
    if (!user) return;

    const relayInfos: RelayInfo[] = this.selectedRelays.map(r => {
      const types: RelayType[] = [];
      if (r.read) types.push('read');
      if (r.write) types.push('write');
      return {
        url: r.url,
        types,
        isPaid: false,
        requiresAuth: false,
        isActive: true,
      };
    });

    const relayTags = RelayListOrchestrator.relayInfosToTags(relayInfos);
    const unsignedEvent = {
      kind: 10002,
      created_at: Math.floor(Date.now() / 1000),
      tags: relayTags,
      content: '',
      pubkey: user.pubkey,
    };

    const signedEvent = await this.authService.signEvent(unsignedEvent);

    const orchestrator = RelayListOrchestrator.getInstance();
    const publishRelays = await this.getPublishRelays();

    await orchestrator.publishRelayList(relayInfos, publishRelays, signedEvent);

    // Replace RelayConfig with the user's chosen relays (clear defaults first)
    const { RelayConfig } = await import('../../services/RelayConfig');
    const relayConfig = RelayConfig.getInstance();
    relayConfig.clearRelays();
    relayInfos.forEach(r => relayConfig.addRelay(r));

    this.eventBus.emit('relays:updated');
  }

  private async publishInboxRelayList(): Promise<void> {
    const selected = this.inboxRelays.filter(r => r.selected);
    if (selected.length === 0) return;

    const user = this.authService.getCurrentUser();
    if (!user) return;

    const tags = selected.map(r => ['relay', r.url]);
    const unsignedEvent = {
      kind: 10050,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: '',
      pubkey: user.pubkey,
    };

    const signedEvent = await this.authService.signEvent(unsignedEvent);

    const { NostrTransport } = await import('../../services/transport/NostrTransport');
    const transport = NostrTransport.getInstance();
    const publishRelays = await this.getPublishRelays();

    await transport.publish(publishRelays, signedEvent);

    // Register inbox relays in RelayConfig so DMService can find them
    const { RelayConfig } = await import('../../services/RelayConfig');
    const relayConfig = RelayConfig.getInstance();
    selected.forEach(r => relayConfig.addRelay({
      url: r.url,
      types: ['inbox'],
      isPaid: false,
      requiresAuth: true,
      isActive: true,
    }));
  }

  private resetFinishButton(
    btn: HTMLButtonElement | null,
    text: HTMLElement | null,
    spinner: HTMLElement | null
  ): void {
    this.publishing = false;
    if (btn) btn.disabled = false;
    if (text) text.style.display = 'inline';
    if (spinner) spinner.style.display = 'none';
  }

  /** Create a step header with heading and intro paragraph */
  private renderStepHeader(parent: HTMLElement, heading: string, intro: string): void {
    const h = document.createElement('h2');
    h.textContent = heading;
    parent.appendChild(h);

    const p = document.createElement('p');
    p.className = 'wizard-intro';
    p.textContent = intro;
    parent.appendChild(p);
  }

  /** Get deduplicated list of write relays + aggregator relays for publishing */
  private async getPublishRelays(): Promise<string[]> {
    const { RelayConfig } = await import('../../services/RelayConfig');
    const aggregators = RelayConfig.getInstance().getAggregatorRelays();
    const writeRelays = this.selectedRelays.filter(r => r.write).map(r => r.url);
    return [...new Set([...writeRelays, ...aggregators])];
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
