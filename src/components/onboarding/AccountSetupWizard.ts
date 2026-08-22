/**
 * AccountSetupWizard
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
import { ModuleLoader } from '../../core/ModuleLoader';
import type {
  ProfileModuleApi,
  ProfileMetadata,
} from '../../modules/profile/contracts';
import { AuthService } from '../../services/AuthService';
import { TypedEventBus } from '../../core/TypedEventBus';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';
import { ImageUploader } from '../profile/ImageUploader';
import { ToastService } from '../../services/ToastService';
import { UserProfileService } from '../../services/UserProfileService';
import type { SettingsModuleApi } from '../../modules/settings/contracts';
import type { RelayInfo, RelayType } from '../../services/RelayConfig';
import { PlatformService } from '../../services/PlatformService';
import {
  generateSecretKey,
  getPublicKey,
  bytesToHex,
  encodeNsec,
  encodeNpub,
} from '../../services/NostrToolsAdapter';
import {
  renderUsernameField,
  renderBioField,
} from '../../helpers/profile-field-helpers';
import { setupCarouselNavigation } from '../../helpers/CarouselHelper';
import { getImageViewer } from '../ui/ImageViewer';

const platform = PlatformService.getInstance();

interface GeneratedKeypair {
  nsec: string;
  npub: string;
  privateKeyHex: string;
  publicKeyHex: string;
}

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
  /**
   * Optional skip-with-confirmation for a step that is technically required
   * but may be skipped after the user confirms an informational dialog.
   * Returns true to proceed (skip), false to stay. When present, the ">"
   * button stays enabled even while validate() is false.
   */
  confirmSkip?: () => Promise<boolean>;
}

import {
  type FollowPack,
  parseFollowPackEvent,
  filterFollowPacks,
} from '../../helpers/parseFollowPack';
import {
  escapeHtml,
  escapeHtmlAttr,
  escapeCssUrl,
} from '../../helpers/escapeHtml';

// Word lists for random username generation
const ADJECTIVES = [
  // Positive & cheerful
  'Happy',
  'Bright',
  'Lucky',
  'Warm',
  'Jolly',
  'Sunny',
  'Lively',
  'Cozy',
  'Merry',
  'Glad',
  'Joyful',
  'Cheery',
  'Blissful',
  'Gleeful',
  'Peppy',
  'Upbeat',
  'Chipper',
  'Breezy',
  'Perky',
  'Bubbly',
  // Strength & courage
  'Bold',
  'Brave',
  'Fierce',
  'Daring',
  'Plucky',
  'Mighty',
  'Tough',
  'Sturdy',
  'Hardy',
  'Gritty',
  'Fearless',
  'Valiant',
  'Gallant',
  'Rugged',
  'Steely',
  'Staunch',
  'Stout',
  'Ironclad',
  'Resolute',
  'Undaunted',
  // Speed & agility
  'Swift',
  'Nimble',
  'Snappy',
  'Quick',
  'Agile',
  'Zippy',
  'Fleet',
  'Deft',
  'Brisk',
  'Sprightly',
  'Hasty',
  'Rapid',
  'Darting',
  'Spry',
  'Limber',
  'Lithe',
  'Bouncy',
  'Frisky',
  'Loping',
  'Scampering',
  // Calm & gentle
  'Calm',
  'Gentle',
  'Quiet',
  'Serene',
  'Mellow',
  'Steady',
  'Humble',
  'Tender',
  'Placid',
  'Tranquil',
  'Docile',
  'Meek',
  'Soothing',
  'Balmy',
  'Hushed',
  'Languid',
  'Dulcet',
  'Velvet',
  'Feathery',
  'Pillowy',
  // Intelligence & wisdom
  'Wise',
  'Clever',
  'Keen',
  'Witty',
  'Lucid',
  'Astute',
  'Sharp',
  'Crafty',
  'Shrewd',
  'Savvy',
  'Canny',
  'Brainy',
  'Learned',
  'Sage',
  'Studious',
  'Curious',
  'Pensive',
  'Knowing',
  'Mindful',
  'Thoughtful',
  // Noble & moral
  'Noble',
  'Kind',
  'Pure',
  'Grand',
  'Honest',
  'Just',
  'Fair',
  'Loyal',
  'True',
  'Gracious',
  'Virtuous',
  'Devout',
  'Earnest',
  'Sincere',
  'Worthy',
  'Regal',
  'Stately',
  'Dignified',
  'Gallant',
  'Courtly',
  // Nature & elemental
  'Wild',
  'Free',
  'Stormy',
  'Frosty',
  'Dusty',
  'Rustic',
  'Mossy',
  'Sandy',
  'Rocky',
  'Leafy',
  'Thorny',
  'Woody',
  'Muddy',
  'Dewy',
  'Ashen',
  'Smoky',
  'Misty',
  'Foggy',
  'Windy',
  'Rainy',
  // Cosmic & mystical
  'Cosmic',
  'Mystic',
  'Stellar',
  'Lunar',
  'Solar',
  'Astral',
  'Arcane',
  'Ethereal',
  'Phantom',
  'Spectral',
  'Eldritch',
  'Fabled',
  'Mythic',
  'Enchanted',
  'Charmed',
  'Haunted',
  'Veiled',
  'Cloaked',
  'Shadowy',
  'Twilight',
  // Color & light
  'Golden',
  'Silver',
  'Crimson',
  'Scarlet',
  'Azure',
  'Amber',
  'Ivory',
  'Copper',
  'Bronze',
  'Onyx',
  'Jade',
  'Ruby',
  'Coral',
  'Indigo',
  'Violet',
  'Tawny',
  'Russet',
  'Gilded',
  'Opal',
  'Pearly',
  // Texture & feel
  'Sleek',
  'Crisp',
  'Fuzzy',
  'Stark',
  'Vivid',
  'Radiant',
  'Glossy',
  'Polished',
  'Grainy',
  'Woven',
  'Braided',
  'Carved',
  'Frosted',
  'Glazed',
  'Burnished',
  'Patched',
  'Rough',
  'Smooth',
  'Silky',
  'Velvety',
  // Temperature & sensation
  'Cool',
  'Zesty',
  'Spicy',
  'Tangy',
  'Bitter',
  'Salty',
  'Peppery',
  'Toasty',
  'Molten',
  'Blazing',
  'Searing',
  'Chilly',
  'Frigid',
  'Tepid',
  'Scalding',
  'Lukewarm',
  'Glacial',
  'Volcanic',
  'Tropical',
  'Arctic',
  // Sound & rhythm
  'Loud',
  'Humming',
  'Ringing',
  'Roaring',
  'Rumbling',
  'Whispering',
  'Chanting',
  'Singing',
  'Droning',
  'Buzzing',
  'Clicking',
  'Ticking',
  'Rattling',
  'Clanking',
  'Booming',
  'Echoing',
  'Lilting',
  'Melodic',
  'Harmonic',
  'Rhythmic',
  // Size & shape
  'Tiny',
  'Vast',
  'Narrow',
  'Wide',
  'Tall',
  'Round',
  'Angular',
  'Twisted',
  'Curved',
  'Spiral',
  'Jagged',
  'Pointed',
  'Blunt',
  'Hollow',
  'Solid',
  'Dense',
  'Lean',
  'Lanky',
  'Squat',
  'Bulky',
  // Time & age
  'Ancient',
  'Primal',
  'Timeless',
  'Ageless',
  'Vintage',
  'Antique',
  'Modern',
  'Fresh',
  'Nascent',
  'Budding',
  'Dawning',
  'Dusk',
  'Eternal',
  'Fleeting',
  'Lasting',
  'Enduring',
  'Bygone',
  'Primeval',
  'Archaic',
  'Newborn',
  // Attitude & mood
  'Sly',
  'Coy',
  'Wry',
  'Smug',
  'Sassy',
  'Feisty',
  'Cheeky',
  'Grumpy',
  'Cranky',
  'Moody',
  'Gloomy',
  'Wistful',
  'Dreamy',
  'Restless',
  'Eager',
  'Anxious',
  'Defiant',
  'Stubborn',
  'Rowdy',
  'Reckless',
  // Misc evocative
  'Stark',
  'Lone',
  'Stray',
  'Rogue',
  'Nomad',
  'Vagrant',
  'Roaming',
  'Drifting',
  'Wandering',
  'Wayward',
  'Exiled',
  'Hidden',
  'Secret',
  'Obscure',
  'Remote',
  'Distant',
  'Forgotten',
  'Lost',
  'Sunken',
  'Buried',
];

const NOUNS = [
  // Animals — mammals
  'Falcon',
  'Otter',
  'Panda',
  'Eagle',
  'Wolf',
  'Dolphin',
  'Fox',
  'Owl',
  'Bear',
  'Hawk',
  'Lynx',
  'Raven',
  'Heron',
  'Whale',
  'Deer',
  'Jaguar',
  'Cobra',
  'Parrot',
  'Bison',
  'Crane',
  'Toucan',
  'Mantis',
  'Badger',
  'Gecko',
  'Pelican',
  'Moose',
  'Osprey',
  'Coyote',
  'Puffin',
  'Condor',
  'Ibis',
  'Newt',
  'Wombat',
  'Ferret',
  'Marten',
  'Salmon',
  'Finch',
  'Beetle',
  'Marlin',
  'Yak',
  'Panther',
  'Stallion',
  'Gazelle',
  'Viper',
  'Scorpion',
  'Sparrow',
  'Starling',
  'Wren',
  'Robin',
  'Magpie',
  'Albatross',
  'Stork',
  'Flamingo',
  'Chameleon',
  'Iguana',
  'Armadillo',
  'Hedgehog',
  'Squirrel',
  'Chipmunk',
  'Raccoon',
  'Possum',
  'Mole',
  'Shrew',
  'Lemur',
  'Gibbon',
  'Macaw',
  'Corgi',
  'Husky',
  'Collie',
  'Mustang',
  'Donkey',
  'Rooster',
  'Goose',
  'Swan',
  'Pigeon',
  'Moth',
  'Cricket',
  'Firefly',
  'Hornet',
  'Wasp',
  'Lobster',
  'Crab',
  'Shrimp',
  'Octopus',
  'Squid',
  'Stingray',
  'Seahorse',
  'Walrus',
  'Seal',
  'Penguin',
  'Turtle',
  'Tortoise',
  'Toad',
  'Frog',
  'Lizard',
  'Snail',
  'Clam',
  'Oyster',
  'Eel',
  'Pike',
  'Trout',
  'Perch',
  'Bass',
  'Carp',
  // Animals — mythical & exotic
  'Phoenix',
  'Griffin',
  'Dragon',
  'Sphinx',
  'Hydra',
  'Kraken',
  'Minotaur',
  'Chimera',
  'Basilisk',
  'Wyvern',
  'Gargoyle',
  'Golem',
  'Titan',
  'Centaur',
  'Cyclops',
  'Leviathan',
  'Behemoth',
  'Unicorn',
  'Pegasus',
  'Siren',
  // Objects & tools
  'Sailboat',
  'Lantern',
  'Compass',
  'Rocket',
  'Anchor',
  'Beacon',
  'Zeppelin',
  'Prism',
  'Pendulum',
  'Telescope',
  'Windmill',
  'Canoe',
  'Gondola',
  'Fiddle',
  'Hammock',
  'Kite',
  'Hourglass',
  'Trumpet',
  'Cauldron',
  'Anvil',
  'Satchel',
  'Quill',
  'Goblet',
  'Loom',
  'Abacus',
  'Barrel',
  'Mortar',
  'Chisel',
  'Bugle',
  'Shuttle',
  'Helm',
  'Flute',
  'Spindle',
  'Wagon',
  'Bellows',
  'Oar',
  'Vessel',
  'Drum',
  'Wrench',
  'Spool',
  'Dagger',
  'Shield',
  'Banner',
  'Pendant',
  'Amulet',
  'Gauntlet',
  'Chalice',
  'Scepter',
  'Trident',
  'Harpoon',
  'Locket',
  'Brooch',
  'Buckle',
  'Lever',
  'Pulley',
  'Cog',
  'Gear',
  'Valve',
  'Piston',
  'Turbine',
  'Propeller',
  'Rudder',
  'Saddle',
  'Bridle',
  'Stirrup',
  'Ladder',
  'Pulpit',
  'Lectern',
  'Easel',
  'Canvas',
  'Palette',
  'Brush',
  'Chisel',
  'Hammer',
  'Tongs',
  'Bellows',
  'Crucible',
  'Furnace',
  'Forge',
  'Kiln',
  'Lathe',
  'Plough',
  'Sickle',
  'Scythe',
  'Spade',
  'Trowel',
  'Pickaxe',
  'Lantern',
  'Torch',
  'Candle',
  'Lamp',
  'Chandelier',
  'Monocle',
  'Spyglass',
  'Sextant',
  'Astrolabe',
  'Sundial',
  'Metronome',
  'Tuning',
  'Gavel',
  'Scroll',
  'Tome',
  'Codex',
  'Atlas',
  'Ledger',
  'Inkwell',
  'Typewriter',
  'Telegraph',
  'Phonograph',
  'Camera',
  'Projector',
  // Vehicles & craft
  'Galleon',
  'Frigate',
  'Clipper',
  'Dinghy',
  'Kayak',
  'Raft',
  'Barge',
  'Trawler',
  'Schooner',
  'Corvette',
  'Biplane',
  'Glider',
  'Balloon',
  'Capsule',
  'Chariot',
  'Carriage',
  'Sleigh',
  'Sled',
  'Trolley',
  'Boxcar',
  // Nature — land
  'Horizon',
  'Comet',
  'Breeze',
  'Summit',
  'River',
  'Canyon',
  'Glacier',
  'Aurora',
  'Meadow',
  'Nebula',
  'Lagoon',
  'Tundra',
  'Reef',
  'Geyser',
  'Dune',
  'Fjord',
  'Marsh',
  'Crater',
  'Torrent',
  'Thicket',
  'Grove',
  'Ravine',
  'Estuary',
  'Ridge',
  'Basin',
  'Delta',
  'Savanna',
  'Plateau',
  'Cove',
  'Steppe',
  'Cascade',
  'Inlet',
  'Bluff',
  'Prairie',
  'Grotto',
  'Coral',
  'Pebble',
  'Driftwood',
  'Willow',
  'Cedar',
  'Birch',
  'Maple',
  'Cypress',
  'Juniper',
  'Hemlock',
  'Spruce',
  'Aspen',
  'Sequoia',
  'Banyan',
  'Bamboo',
  'Fern',
  'Thistle',
  'Clover',
  'Ivy',
  'Moss',
  'Lichen',
  'Orchid',
  'Dahlia',
  'Lotus',
  'Tulip',
  'Iris',
  'Poppy',
  'Violet',
  'Jasmine',
  'Sage',
  'Thyme',
  'Basil',
  'Rosemary',
  'Lavender',
  'Mint',
  'Bramble',
  'Briar',
  'Thorn',
  'Acorn',
  'Pinecone',
  'Boulder',
  'Cobble',
  'Granite',
  'Obsidian',
  'Slate',
  'Marble',
  'Sandstone',
  'Limestone',
  'Flint',
  'Chalk',
  'Clay',
  'Loam',
  'Humus',
  'Silt',
  'Gravel',
  // Nature — water & sky
  'Tide',
  'Wave',
  'Surf',
  'Foam',
  'Spray',
  'Mist',
  'Drizzle',
  'Downpour',
  'Squall',
  'Tempest',
  'Cyclone',
  'Typhoon',
  'Monsoon',
  'Blizzard',
  'Hailstone',
  'Sleet',
  'Thunder',
  'Lightning',
  'Rainbow',
  'Halo',
  'Eclipse',
  'Solstice',
  'Equinox',
  'Twilight',
  'Dawn',
  'Dusk',
  'Sunrise',
  'Sunset',
  'Starlight',
  'Moonbeam',
  'Sunray',
  'Cloud',
  'Cirrus',
  'Cumulus',
  'Stratus',
  'Nimbus',
  'Vortex',
  'Whirlpool',
  'Maelstrom',
  'Current',
  'Eddy',
  'Ripple',
  'Spring',
  'Brook',
  'Creek',
  'Stream',
  'Pond',
  'Lake',
  'Swamp',
  'Bog',
  'Fen',
  'Oasis',
  // Nature — earth & geology
  'Volcano',
  'Caldera',
  'Cavern',
  'Gorge',
  'Chasm',
  'Abyss',
  'Trench',
  'Fault',
  'Ledge',
  'Cliff',
  'Spire',
  'Pinnacle',
  'Mesa',
  'Butte',
  'Outcrop',
  'Moraine',
  'Glacier',
  'Iceberg',
  'Permafrost',
  'Magma',
  // Space & cosmos
  'Nova',
  'Quasar',
  'Pulsar',
  'Meteor',
  'Asteroid',
  'Orbit',
  'Galaxy',
  'Cosmos',
  'Void',
  'Rift',
  'Warp',
  'Flux',
  'Photon',
  'Proton',
  'Neutron',
  'Electron',
  'Atom',
  'Plasma',
  'Spectrum',
  'Prism',
  // Abstract — fate & drama
  'Fate',
  'Drama',
  'Chaos',
  'Order',
  'Chance',
  'Destiny',
  'Fortune',
  'Karma',
  'Nemesis',
  'Paradox',
  'Dilemma',
  'Crisis',
  'Climax',
  'Twist',
  'Plot',
  'Scheme',
  'Gambit',
  'Ruse',
  'Bluff',
  'Wager',
  'Stake',
  'Verdict',
  'Oath',
  'Pledge',
  'Vow',
  'Decree',
  'Edict',
  'Mandate',
  'Truce',
  'Pact',
  // Abstract — emotions & states
  'Fury',
  'Rage',
  'Wrath',
  'Spite',
  'Envy',
  'Pride',
  'Shame',
  'Guilt',
  'Grief',
  'Sorrow',
  'Bliss',
  'Joy',
  'Hope',
  'Dread',
  'Angst',
  'Malice',
  'Grace',
  'Mercy',
  'Valor',
  'Honor',
  'Glory',
  'Virtue',
  'Folly',
  'Hubris',
  'Guile',
  'Cunning',
  'Grit',
  'Nerve',
  'Pluck',
  'Zeal',
  // Abstract — thought & concept
  'Spark',
  'Echo',
  'Drift',
  'Ember',
  'Frost',
  'Riddle',
  'Whisper',
  'Mirage',
  'Zenith',
  'Cadence',
  'Mosaic',
  'Voyage',
  'Flare',
  'Tempo',
  'Cipher',
  'Saga',
  'Fable',
  'Rune',
  'Odyssey',
  'Verve',
  'Lumen',
  'Aura',
  'Motif',
  'Reverie',
  'Presto',
  'Quartz',
  'Axiom',
  'Tangent',
  'Theorem',
  'Maxim',
  'Creed',
  'Dogma',
  'Canon',
  'Thesis',
  'Premise',
  'Notion',
  'Whim',
  'Hunch',
  'Inkling',
  'Epiphany',
  'Omen',
  'Portent',
  'Herald',
  'Signal',
  'Beacon',
  'Token',
  'Symbol',
  'Emblem',
  'Sigil',
  'Glyph',
  'Cipher',
  'Code',
  'Key',
  'Lock',
  'Puzzle',
  'Maze',
  'Labyrinth',
  'Spiral',
  'Loop',
  'Knot',
  // Abstract — action & event
  'Clash',
  'Surge',
  'Burst',
  'Rush',
  'Dash',
  'Leap',
  'Plunge',
  'Dive',
  'Charge',
  'Rally',
  'Siege',
  'Raid',
  'Ambush',
  'Heist',
  'Quest',
  'Crusade',
  'Venture',
  'Gamble',
  'Hustle',
  'Grind',
  'Sprint',
  'March',
  'Stride',
  'Trek',
  'Pilgrimage',
  'Exodus',
  'Revolt',
  'Mutiny',
  'Coup',
  'Uprising',
  // Abstract — time & change
  'Epoch',
  'Era',
  'Moment',
  'Phase',
  'Cycle',
  'Shift',
  'Turn',
  'Pivot',
  'Onset',
  'Prelude',
  'Finale',
  'Encore',
  'Interlude',
  'Overture',
  'Crescendo',
  'Requiem',
  'Elegy',
  'Ballad',
  'Anthem',
  'Hymn',
  'Psalm',
  'Sonnet',
  'Verse',
  'Stanza',
  'Canto',
  'Prologue',
  'Epilogue',
  'Chapter',
  'Volume',
  'Scroll',
  // Abstract — society & roles
  'Outlaw',
  'Rebel',
  'Pilgrim',
  'Nomad',
  'Hermit',
  'Wanderer',
  'Drifter',
  'Sage',
  'Oracle',
  'Prophet',
  'Mystic',
  'Shaman',
  'Druid',
  'Monk',
  'Knight',
  'Squire',
  'Baron',
  'Duke',
  'Earl',
  'Marquis',
  'Consul',
  'Tribune',
  'Envoy',
  'Herald',
  'Scribe',
  'Bard',
  'Minstrel',
  'Jester',
  'Rogue',
  'Bandit',
  // Materials & substances
  'Amber',
  'Topaz',
  'Garnet',
  'Sapphire',
  'Emerald',
  'Diamond',
  'Onyx',
  'Jade',
  'Pearl',
  'Opal',
  'Cobalt',
  'Chrome',
  'Nickel',
  'Zinc',
  'Copper',
  'Bronze',
  'Brass',
  'Iron',
  'Steel',
  'Titanium',
  'Carbon',
  'Silicon',
  'Mercury',
  'Neon',
  'Argon',
  'Helium',
  'Radium',
  'Sulfur',
  'Phosphor',
  'Crystal',
  // Food & drink
  'Pepper',
  'Ginger',
  'Saffron',
  'Cinnamon',
  'Nutmeg',
  'Vanilla',
  'Cocoa',
  'Espresso',
  'Matcha',
  'Chai',
  'Mango',
  'Papaya',
  'Coconut',
  'Walnut',
  'Almond',
  'Hazel',
  'Cashew',
  'Pecan',
  'Olive',
  'Fig',
  // Music & art
  'Riff',
  'Chord',
  'Note',
  'Scale',
  'Beat',
  'Bass',
  'Treble',
  'Alto',
  'Tenor',
  'Soprano',
  'Aria',
  'Fugue',
  'Opus',
  'Sketch',
  'Fresco',
  'Mural',
  'Etching',
  'Collage',
  'Montage',
  'Tableau',
  // Architecture & places
  'Tower',
  'Citadel',
  'Bastion',
  'Rampart',
  'Turret',
  'Parapet',
  'Vault',
  'Crypt',
  'Dungeon',
  'Keep',
  'Moat',
  'Drawbridge',
  'Gatehouse',
  'Arcade',
  'Colonnade',
  'Rotunda',
  'Atrium',
  'Alcove',
  'Balcony',
  'Terrace',
  'Pavilion',
  'Gazebo',
  'Pergola',
  'Arbor',
  'Courtyard',
  'Plaza',
  'Bazaar',
  'Harbor',
  'Wharf',
  'Pier',
];

// DiceBear avatar styles to mix for variety
const DICEBEAR_STYLES = [
  'adventurer',
  'avataaars',
  'bottts',
  'fun-emoji',
  'lorelei',
  'micah',
  'notionists',
  'open-peeps',
  'personas',
  'pixel-art',
  'shapes',
  'thumbs',
];

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

// Curated default content-relay set. Three large, long-running general-
// purpose relays plus one stable secondary. Every new account starts
// with these as Read+Write. Picked for: high user count, multi-year
// uptime, broadly compatible with every Nostr client out there.
//
// Notable omissions:
//   - `purplepag.es` — runs in the background as the canonical profile
//     indexer (see RelayConfig.getMetadataRelays). Putting it into the
//     user-facing pool would muddle its role: it's not a general
//     content-write target, it's a metadata indexer. NoorNote pushes
//     kind:0 / kind:10002 / kind:10050 to it automatically via
//     publishEverywhere regardless of the user's NIP-65 setup. Keeping
//     it out of the wizard avoids confusing the user about its role.
//   - `relay.mostr.pub` / `momostr.pink` — ActivityPub bridges. Useful
//     for users who specifically want Mastodon cross-posting, but
//     shipping them by default ships an opinion most users haven't
//     formed yet. They can be added manually in Settings → Relays.
//   - `relay.damus.io` — removed as default 2026-06-10 (relay-operator
//     conduct). Users may still add it manually in Settings.
//
// Source: stats.andotherstuff.org 2026 + cross-checked against nostr.watch
// reliability metrics. nos.lol, relay.primal.net and nostr.oxtr.dev are large,
// high-uptime general relays (verified to serve reads + accept writes for new
// accounts).
const DEFAULT_CONTENT_RELAYS: string[] = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.oxtr.dev',
];

// NIP-17 DM inbox relays, hard-coded for every new account. Both relays
// support NIP-40 (expiration) so disappearing-DMs work out of the box. Users
// can change these later under Settings → Relays.
const INBOX_RELAYS: string[] = [
  'wss://relay.0xchat.com',
  'wss://auth.nostr1.com',
];

function generateRandomUsername(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}${noun}`;
}

export class AccountSetupWizard {
  private router: Router;
  private _profileApi?: ProfileModuleApi | null;
  private get profileApi(): ProfileModuleApi | null {
    return (this._profileApi ??=
      ModuleLoader.getInstance().getApi<ProfileModuleApi>('profile'));
  }
  private authService: AuthService;
  private eventBus: TypedEventBus;
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

  /** Generated keypair (before login) */
  private currentKeypair: GeneratedKeypair | null = null;
  /** Whether backup was confirmed */
  private backupConfirmed: boolean = false;

  /** The fullscreen container we inject into #app */
  private container: HTMLElement | null = null;
  /** The original #app content (MainLayout), hidden during wizard */
  private originalAppContent: HTMLElement[] = [];

  constructor() {
    this.router = Router.getInstance();
    this.authService = AuthService.getInstance();
    this.eventBus = TypedEventBus.getInstance();
    this.storage = PerAccountLocalStorage.getInstance();

    // Build steps list based on platform
    const isDesktop = platform.isDesktop;
    const isMobile = platform.isAndroid;

    if (isDesktop) {
      // Desktop: Keypair → Backup → NoorSigner → Profile Setup → Lightning → Done
      this.steps = [
        this.createKeypairStep(),
        this.createBackupStep(),
        this.createNoorSignerImportStep(),
        this.createUsernameStep(),
        this.createAvatarStep(),
        this.createBioStep(),
        this.createFollowPacksStep(),
        this.createLightningStep(),
        this.createDoneStep(),
      ];
    } else if (isMobile) {
      // Mobile: Keypair → Backup → Profile Setup → Lightning → Done (no NoorSigner, no Extension)
      this.steps = [
        this.createKeypairStep(),
        this.createBackupStep(),
        this.createUsernameStep(),
        this.createAvatarStep(),
        this.createBioStep(),
        this.createFollowPacksStep(),
        this.createLightningStep(),
        this.createDoneStep(),
      ];
    } else {
      // Web: Keypair → Backup → Sidecar → Login → Profile Setup → Lightning → Done
      // Same order as Desktop (signer step right after the backup), with the
      // Lightning wallet at the end where it's optional.
      this.steps = [
        this.createKeypairStep(),
        this.createBackupStep(),
        this.createSidecarStep(),
        this.createLoginStep(),
        this.createUsernameStep(),
        this.createAvatarStep(),
        this.createBioStep(),
        this.createFollowPacksStep(),
        this.createLightningStep(),
        this.createDoneStep(),
      ];
    }

    // Relays are no longer a wizard step — most beginners can't judge which
    // relay does what. Seed sensible defaults (changeable later in Settings):
    // mainstream content relays as read/write + the hard-coded NIP-17 DM
    // inbox relays (INBOX_RELAYS).
    this.selectedRelays = DEFAULT_CONTENT_RELAYS.map(url => ({
      url,
      read: true,
      write: true,
    }));
    this.inboxRelays = INBOX_RELAYS.map(url => ({ url, selected: true }));
  }

  /**
   * Show the wizard fullscreen, hiding the main app layout
   */
  public show(): void {
    const app = document.getElementById('app');
    if (!app) return;

    // Hide all existing app children (MainLayout etc.)
    this.originalAppContent = Array.from(app.children) as HTMLElement[];
    this.originalAppContent.forEach(el => (el.style.display = 'none'));

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

    // Clear key material from memory
    this.currentKeypair = null;

    if (this.container) {
      this.container.remove();
      this.container = null;
    }

    // Restore original app content
    this.originalAppContent.forEach(el => (el.style.display = ''));
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
        const section = this.container.querySelector(
          '.wizard-avatar-upload-section'
        );
        if (section) {
          avatarUploader.setupEventListeners(section as HTMLElement);
        }
      }
    }
  }

  private renderProgress(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'wizard-progress';

    const contentSteps = this.steps.filter(
      s => s.id !== 'welcome' && s.id !== 'done'
    );
    const currentContentIndex = contentSteps.findIndex(
      s => s.id === this.steps[this.currentStepIndex]!.id
    );

    el.innerHTML = contentSteps
      .map((step, i) => {
        const state =
          i < currentContentIndex
            ? 'completed'
            : i === currentContentIndex
              ? 'active'
              : 'upcoming';
        return `<div class="wizard-progress-dot wizard-progress-dot--${state}" title="${step.title}"></div>`;
      })
      .join('<div class="wizard-progress-line"></div>');

    return el;
  }

  private renderNavigation(step: WizardStep): HTMLElement {
    const nav = document.createElement('div');
    nav.className = 'wizard-nav l-row--split';

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
    }

    if (showSkip) {
      const skipBtn = document.createElement('button');
      skipBtn.className = 'btn btn--large btn--passive';
      skipBtn.textContent = 'Skip';
      skipBtn.addEventListener('click', () => this.goToNextStep());
      navLeft.appendChild(skipBtn);
    }
    nav.appendChild(navLeft);

    const navRight = document.createElement('div');
    navRight.className = 'wizard-nav-right';

    if (!isFirst) {
      const prevBtn = document.createElement('button');
      prevBtn.className = 'btn btn--square-elg btn--passive';
      prevBtn.textContent = '<';
      prevBtn.addEventListener('click', () => this.goToPreviousStep());
      navRight.appendChild(prevBtn);
    }

    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn btn--square-elg';
    nextBtn.textContent = '>';
    // Set initial state based on validation (after a microtask to let render complete)
    if (isRequired && !step.confirmSkip) {
      nextBtn.disabled = true;
      setTimeout(() => {
        nextBtn.disabled = !step.validate();
      }, 0);
    }
    nextBtn.setAttribute('data-wizard-action', 'next');
    nextBtn.addEventListener('click', async () => {
      if (step.validate()) {
        step.collect();
        this.goToNextStep();
      } else if (step.confirmSkip) {
        // Step is technically required but skippable after an informational
        // confirmation (the Lightning wallet step on every platform).
        const proceed = await step.confirmSkip();
        if (proceed) {
          step.collect();
          this.goToNextStep();
        }
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

  /**
   * Informational confirmation shown when the user tries to advance past the
   * Lightning wallet step without having connected a wallet. Returns true to
   * skip the step, false to stay. Used on all platforms (Rizful step on Web,
   * Lightning step on Desktop/Android).
   */
  private async confirmSkipWallet(): Promise<boolean> {
    const { ModalService } = await import('../../services/ModalService');
    return ModalService.getInstance().confirm({
      title: 'Set Up Wallet Later?',
      message:
        'A Lightning wallet lets you send and receive Zaps. You can set one up anytime later in Settings, but we recommend starting with a working wallet so you can zap right away.',
      confirmText: 'Skip for now',
      cancelText: 'Go back',
    });
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

    content
      .querySelector('[data-action="no"]')!
      .addEventListener('click', () => {
        modalService.hide();
      });

    content
      .querySelector('[data-action="yes"]')!
      .addEventListener('click', async () => {
        modalService.hide();

        const pubkey = this.authService.getCurrentUser()?.pubkey;

        // Clear wizard localStorage
        this.clearProgress();
        this.storage.remove(StorageKeys.NEEDS_PROFILE_SETUP);

        if (pubkey) {
          // Remove keypair from NoorSigner filesystem (desktop only)
          if (platform.isDesktop) {
            try {
              const { hexToNpub } = await import('../../helpers/nip19');
              const npub = hexToNpub(pubkey);
              if (npub) {
                await window.electronAPI!.removeNoorSignerAccount(npub);
              }
            } catch (e) {
              console.warn(
                '[AccountSetupWizard] Failed to remove NoorSigner account files:',
                e
              );
            }
          }

          // Remove from localStorage + sign out
          await this.authService.removeStoredAccount(pubkey);

          // Switch to previous account if one exists
          const { AccountStorageService } = await import(
            '../../services/AccountStorageService'
          );
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
    const btn = document.querySelector(
      '[data-wizard-action="next"]'
    ) as HTMLButtonElement;
    if (btn) btn.disabled = !enabled;
  }

  // ─── Step Definitions ──────────────────────────────────────

  // ─── Account Creation Steps ────────────────────────────────────

  /**
   * Step: Generate keypair (Both platforms)
   */
  private createKeypairStep(): WizardStep {
    return {
      id: 'keypair',
      title: 'Keypair',
      required: true,
      render: () => {
        // Generate keypair if not already done
        if (!this.currentKeypair) {
          const secretKey = generateSecretKey();
          const privateKeyHex = bytesToHex(secretKey);
          const publicKeyHex = getPublicKey(secretKey);
          secretKey.fill(0); // Zero out raw key material
          this.currentKeypair = {
            nsec: encodeNsec(privateKeyHex),
            npub: encodeNpub(publicKeyHex),
            privateKeyHex,
            publicKeyHex,
          };
        }

        const el = document.createElement('div');
        this.renderStepHeader(
          el,
          'Your Nostr Identity',
          'Your Nostr identity is a cryptographic key pair. The private key (nsec) is your password. The public key (npub) is your username.'
        );

        el.innerHTML += `
          <div class="wizard-keypair-display">
            <div class="wizard-keypair-item wizard-keypair-item--critical">
              <label>Private Key (nsec) - KEEP THIS SECRET!</label>
              <div class="wizard-input-row">
                <input type="text" class="input input--monospace" value="${this.currentKeypair.nsec}" readonly data-key="nsec" />
                <button class="btn btn--large" data-action="copy-nsec">Copy</button>
              </div>
            </div>

            <div class="wizard-keypair-item">
              <label>Public Key (npub) - Your username</label>
              <div class="wizard-input-row">
                <input type="text" class="input input--monospace" value="${this.currentKeypair.npub}" readonly data-key="npub" />
                <button class="btn btn--large" data-action="copy-npub">Copy</button>
              </div>
            </div>
          </div>

          <div class="wizard-keypair-actions">
            <button class="btn btn--passive" data-action="regenerate">Regenerate Keys</button>
          </div>
        `;

        // Setup listeners
        setTimeout(() => this.setupKeypairListeners(), 0);

        return el;
      },
      validate: () => !!this.currentKeypair,
      collect: () => {},
    };
  }

  /**
   * Setup listeners for keypair step
   */
  private setupKeypairListeners(): void {
    const container = this.container;
    if (!container) return;

    // Copy buttons
    container
      .querySelector('[data-action="copy-nsec"]')
      ?.addEventListener('click', async () => {
        if (this.currentKeypair) {
          try {
            await navigator.clipboard.writeText(this.currentKeypair.nsec);
            ToastService.show('nsec copied to clipboard', 'success');
          } catch {
            ToastService.show('Failed to copy', 'error');
          }
        }
      });

    container
      .querySelector('[data-action="copy-npub"]')
      ?.addEventListener('click', async () => {
        if (this.currentKeypair) {
          try {
            await navigator.clipboard.writeText(this.currentKeypair.npub);
            ToastService.show('npub copied to clipboard', 'success');
          } catch {
            ToastService.show('Failed to copy', 'error');
          }
        }
      });

    // Regenerate
    container
      .querySelector('[data-action="regenerate"]')
      ?.addEventListener('click', () => {
        const secretKey = generateSecretKey();
        const privateKeyHex = bytesToHex(secretKey);
        const publicKeyHex = getPublicKey(secretKey);
        secretKey.fill(0); // Zero out raw key material
        this.currentKeypair = {
          nsec: encodeNsec(privateKeyHex),
          npub: encodeNpub(publicKeyHex),
          privateKeyHex,
          publicKeyHex,
        };
        this.backupConfirmed = false;

        const nsecInput = container.querySelector(
          '[data-key="nsec"]'
        ) as HTMLInputElement;
        const npubInput = container.querySelector(
          '[data-key="npub"]'
        ) as HTMLInputElement;
        if (nsecInput) nsecInput.value = this.currentKeypair.nsec;
        if (npubInput) npubInput.value = this.currentKeypair.npub;

        ToastService.show('New keypair generated', 'success');
      });

    // Keypair is already generated, enable Next button
    if (this.currentKeypair) {
      this.updateNextButtonState(true);
    }
  }

  /**
   * Step: Download backup (Both platforms)
   */
  private createBackupStep(): WizardStep {
    return {
      id: 'backup',
      title: 'Backup',
      required: true,
      render: () => {
        const el = document.createElement('div');

        this.renderStepHeader(
          el,
          'Save Your Backup',
          'Download a backup of your keypair. If you lose this, you lose access forever. You will paste this nsec into Sidecar in the next step.'
        );

        el.innerHTML += `
          <div class="wizard-backup-warning">
            <p><strong>There is no password recovery.</strong></p>
            <p>If you lose your private key, you lose access to your account forever.
            No one can help you recover it, not even us.</p>
          </div>

          <div class="wizard-extension-action">
            <button class="btn btn--large" data-action="download-backup">
              Download Backup
            </button>
            <p class="wizard-hint">Save this file in a secure location</p>
          </div>

          <div class="wizard-backup-confirmation">
            <label class="checkbox-label">
              <input type="checkbox" data-action="confirm-backup" ${this.backupConfirmed ? 'checked' : ''} />
              <span>I have downloaded and saved my backup</span>
            </label>
          </div>
        `;

        // Setup listeners
        setTimeout(() => this.setupBackupListeners(), 0);

        return el;
      },
      validate: () => this.backupConfirmed,
      collect: () => {},
    };
  }

  /**
   * Setup listeners for backup step
   */
  private setupBackupListeners(): void {
    const container = this.container;
    if (!container) return;

    // Download backup
    container
      .querySelector('[data-action="download-backup"]')
      ?.addEventListener('click', () => this.downloadBackup());

    // Confirmation checkbox
    const confirmCheckbox = container.querySelector(
      '[data-action="confirm-backup"]'
    ) as HTMLInputElement;
    if (confirmCheckbox) {
      confirmCheckbox.addEventListener('change', () => {
        this.backupConfirmed = confirmCheckbox.checked;
        this.updateNextButtonState(this.backupConfirmed);
      });
    }
  }

  /**
   * Download backup file (platform-aware)
   */
  private async downloadBackup(): Promise<void> {
    if (!this.currentKeypair) return;

    let content = `NOSTR ACCOUNT BACKUP
====================
Generated: ${new Date().toISOString()}

PRIVATE KEY (nsec) - KEEP THIS SECRET!
${this.currentKeypair.nsec}

PUBLIC KEY (npub) - Your username
${this.currentKeypair.npub}
`;

    content += `
IMPORTANT:
- Your private key IS your account
- There is NO password recovery
- If you lose this file, you lose access forever
- Store this file in a secure location
`;

    const defaultFileName = `nostr-backup-${this.currentKeypair.npub.slice(0, 12)}.txt`;

    try {
      if (platform.isElectron) {
        // Electron Desktop: Use native save dialog
        const filePath = await window.electronAPI!.saveFileDialog({
          defaultPath: defaultFileName,
          filters: [{ name: 'Text Files', extensions: ['txt'] }],
        });

        if (filePath) {
          await window.electronAPI!.writeTextFile(filePath, content);
          ToastService.show('Backup saved', 'success');
        }
      } else if ('showSaveFilePicker' in window) {
        // Web: File System Access API
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: defaultFileName,
          types: [
            { description: 'Text Files', accept: { 'text/plain': ['.txt'] } },
          ],
        });
        const writable = await handle.createWritable();
        await writable.write(content);
        await writable.close();
        ToastService.show('Backup saved', 'success');
      } else {
        // Fallback: Direct download
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = defaultFileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        ToastService.show('Backup saved to Downloads folder', 'success');
      }
    } catch (error) {
      console.error('Failed to save backup:', error);
      ToastService.show('Failed to save backup', 'error');
    }
  }

  /**
   * Step: Import to NoorSigner (Desktop only)
   */
  private createNoorSignerImportStep(): WizardStep {
    return {
      id: 'noorsigner',
      title: 'NoorSigner',
      required: true,
      render: () => {
        const el = document.createElement('div');
        this.renderStepHeader(
          el,
          'Secure Your Key with NoorSigner',
          'NoorSigner is a local key manager that runs on your machine. Your private key never leaves your computer.'
        );

        el.innerHTML += `
          <div class="wizard-info-box">
            <p>Your nsec will be securely stored by NoorSigner:</p>
            <ul>
              <li>Encrypted with AES-256</li>
              <li>Stored locally at <code>~/.noorsigner/accounts/</code></li>
              <li>Never transmitted over the internet</li>
              <li>You'll set a password to unlock it</li>
            </ul>
          </div>

          <div class="wizard-extension-action">
            <button class="btn btn--large" data-action="import-noorsigner">
              Import to NoorSigner
            </button>
            <p class="wizard-hint">You'll set a password in the next dialog</p>
          </div>

          <div class="wizard-status" data-status></div>
        `;

        // Setup listeners
        setTimeout(() => this.setupNoorSignerListeners(), 0);

        return el;
      },
      validate: () => !!this.authService.getCurrentUser(),
      collect: () => {},
    };
  }

  /**
   * Setup listeners for NoorSigner import step
   */
  private setupNoorSignerListeners(): void {
    const container = this.container;
    if (!container || !this.currentKeypair) return;

    const importBtn = container.querySelector(
      '[data-action="import-noorsigner"]'
    );
    const statusEl = container.querySelector('[data-status]') as HTMLElement;

    if (importBtn) {
      importBtn.addEventListener('click', async () => {
        const { ImportToNoorSignerModal } = await import(
          '../modals/ImportToNoorSignerModal'
        );

        const modal = new ImportToNoorSignerModal({
          nsec: this.currentKeypair!.nsec,
          npub: this.currentKeypair!.npub,
          onSuccess: async () => {
            localStorage.setItem('noornote_has_key', 'true');

            // Auto-login
            try {
              const result = await this.authService.authenticateWithKeySigner();
              if (result.success && result.pubkey) {
                // Set NEEDS_PROFILE_SETUP flag
                this.storage.setForPubkey(
                  StorageKeys.NEEDS_PROFILE_SETUP,
                  result.pubkey,
                  true
                );
                ToastService.show('Logged in!', 'success');
                this.updateNextButtonState(true);
                // Auto-advance to next step
                this.goToNextStep();
              } else {
                if (statusEl)
                  statusEl.textContent = result.error || 'Login failed';
              }
            } catch (error) {
              if (statusEl) statusEl.textContent = 'Login failed';
            }
          },
          onCancel: () => {},
        });
        modal.show();
      });
    }
  }

  /**
   * Step: Install Sidecar and import the nsec (Web only)
   */
  private createSidecarStep(): WizardStep {
    return {
      id: 'sidecar',
      title: 'Sidecar',
      required: true,
      render: () => {
        const el = document.createElement('div');
        this.renderStepHeader(
          el,
          'Set up Sidecar',
          'Sidecar is a browser extension that keeps your key encrypted on this device and signs events for you, so no website ever sees your nsec.'
        );

        el.innerHTML += `
          <div class="wizard-extension-action">
            <a href="https://chromewebstore.google.com/detail/sidecar-a-classy-nostr-si/moimlikilhheabdafocpmneehpblhiln" target="_blank" rel="noopener noreferrer" class="btn btn--large">
              Install Sidecar
            </a>
            <p class="wizard-hint">Opens the Chrome Web Store in a new tab</p>
          </div>

          <div class="nn-carousel nn-carousel--sidecar">
            <div class="nn-carousel-slides">
              <div class="nn-carousel-slide active" data-slide="0">
                <img src="/images/sidecar/sidecar-01.png" alt="Add Sidecar to Chrome" class="nn-carousel-image" />
                <p class="nn-carousel-caption">Click <strong>"Add to Chrome"</strong> to install Sidecar</p>
              </div>
              <div class="nn-carousel-slide" data-slide="1">
                <img src="/images/sidecar/sidecar-02.png" alt="Sidecar installed" class="nn-carousel-image" />
                <p class="nn-carousel-caption">Installed, your Nostr signer is ready</p>
              </div>
              <div class="nn-carousel-slide" data-slide="2">
                <img src="/images/sidecar/sidecar-03.png" alt="Pin Sidecar" class="nn-carousel-image" />
                <p class="nn-carousel-caption">Open the <strong>puzzle-piece menu</strong> and pin Sidecar</p>
              </div>
              <div class="nn-carousel-slide" data-slide="3">
                <img src="/images/sidecar/sidecar-04.png" alt="Sidecar pinned" class="nn-carousel-image" />
                <p class="nn-carousel-caption">Sidecar now stays in your toolbar</p>
              </div>
              <div class="nn-carousel-slide" data-slide="4">
                <img src="/images/sidecar/sidecar-05.png" alt="Set a PIN" class="nn-carousel-image" />
                <p class="nn-carousel-caption">Click it, set a <strong>PIN or passphrase</strong> (min. 4 characters), then <strong>"Create keystore"</strong></p>
              </div>
              <div class="nn-carousel-slide" data-slide="5">
                <img src="/images/sidecar/sidecar-06.png" alt="Import nsec" class="nn-carousel-image" />
                <p class="nn-carousel-caption">Click <strong>"Import nsec"</strong></p>
              </div>
              <div class="nn-carousel-slide" data-slide="6">
                <img src="/images/sidecar/sidecar-07.png" alt="Paste nsec" class="nn-carousel-image" />
                <p class="nn-carousel-caption">Paste your <strong>nsec</strong>, copied in step 1 or from your backup file</p>
              </div>
              <div class="nn-carousel-slide" data-slide="7">
                <img src="/images/sidecar/sidecar-08.png" alt="Import account" class="nn-carousel-image" />
                <p class="nn-carousel-caption">Sidecar loads your profile, click <strong>"Import account"</strong></p>
              </div>
              <div class="nn-carousel-slide" data-slide="8">
                <img src="/images/sidecar/sidecar-09.png" alt="Sidecar ready" class="nn-carousel-image" />
                <p class="nn-carousel-caption">Done. Your identity is in Sidecar, now log in to NoorNote</p>
              </div>
            </div>
            <div class="nn-carousel-nav">
              <button class="btn btn--mini btn--passive" data-action="prev-slide" disabled>Previous</button>
              <span class="nn-carousel-dots"></span>
              <button class="btn btn--mini" data-action="next-slide">Next</button>
            </div>
          </div>
        `;

        // Setup carousel after render
        setTimeout(() => this.setupSidecarCarousel(), 0);

        return el;
      },
      validate: () => true, // Can't verify, trust user
      collect: () => {},
    };
  }

  /**
   * Setup Sidecar carousel navigation and image click handlers
   */
  private setupSidecarCarousel(): void {
    const container = this.container;
    if (!container) return;

    const carousel = container.querySelector(
      '.nn-carousel--sidecar'
    ) as HTMLElement;
    if (carousel) {
      setupCarouselNavigation(carousel);

      // Make images clickable to enlarge
      const images = carousel.querySelectorAll(
        '.nn-carousel-image'
      ) as NodeListOf<HTMLImageElement>;
      const imageSrcs = Array.from(images).map(img => img.src);

      images.forEach((img, index) => {
        img.style.cursor = 'pointer';
        img.addEventListener('click', () => {
          getImageViewer().open({ images: imageSrcs, initialIndex: index });
        });
      });
    }
  }

  /**
   * Step: Login with extension (Web only)
   */
  private createLoginStep(): WizardStep {
    return {
      id: 'login',
      title: 'Login',
      required: true,
      render: () => {
        const el = document.createElement('div');
        this.renderStepHeader(
          el,
          'Login',
          'Everything is set up! Click below to log in with your new account.'
        );

        el.innerHTML += `
          <div class="wizard-extension-action">
            <button class="btn btn--large" data-action="login-extension">
              Login with Extension
            </button>
            <p class="wizard-hint">Sidecar will ask you to confirm</p>
          </div>

          <div class="wizard-status" data-status></div>
        `;

        // Setup listeners
        setTimeout(() => this.setupLoginListeners(), 0);

        return el;
      },
      validate: () => !!this.authService.getCurrentUser(),
      collect: () => {},
    };
  }

  /**
   * Setup listeners for login step
   */
  private setupLoginListeners(): void {
    const container = this.container;
    if (!container) return;

    const loginBtn = container.querySelector(
      '[data-action="login-extension"]'
    ) as HTMLButtonElement;
    const statusEl = container.querySelector('[data-status]') as HTMLElement;

    if (loginBtn) {
      loginBtn.addEventListener('click', async () => {
        loginBtn.disabled = true;
        loginBtn.textContent = 'Connecting...';

        try {
          const result = await this.authService.authenticate();

          if (result.success && result.pubkey) {
            // Set NEEDS_PROFILE_SETUP flag
            this.storage.setForPubkey(
              StorageKeys.NEEDS_PROFILE_SETUP,
              result.pubkey,
              true
            );

            localStorage.setItem('noornote_has_key', 'true');
            ToastService.show('Logged in!', 'success');
            this.updateNextButtonState(true);
            // Auto-advance to next step
            this.goToNextStep();
          } else {
            if (statusEl) statusEl.textContent = result.error || 'Login failed';
            loginBtn.disabled = false;
            loginBtn.textContent = 'Login with Extension';
          }
        } catch (error) {
          if (statusEl) statusEl.textContent = 'Login failed';
          loginBtn.disabled = false;
          loginBtn.textContent = 'Login with Extension';
        }
      });
    }
  }

  // ─── Profile Setup Steps ──────────────────────────────────────

  private createUsernameStep(): WizardStep {
    return {
      id: 'username',
      title: 'Username',
      required: true,
      render: () => {
        const el = document.createElement('div');
        this.renderStepHeader(
          el,
          'Choose a Username',
          'Your username is how others will find and mention you. Pick one of these or type your own.'
        );

        // Suggestion chips
        const chipsContainer = document.createElement('div');
        chipsContainer.className = 'wizard-username-suggestions';

        const renderChips = () => {
          chipsContainer.innerHTML = '';
          const names = Array.from({ length: 6 }, () =>
            generateRandomUsername()
          );
          names.forEach(name => {
            const chip = document.createElement('button');
            chip.className = 'wizard-suggestion-chip';
            chip.textContent = name;
            chip.addEventListener('click', () => {
              const input = this.container?.querySelector(
                '#name'
              ) as HTMLInputElement;
              if (input) {
                input.value = name;
                input.dispatchEvent(new Event('input'));
              }
              chipsContainer
                .querySelectorAll('.wizard-suggestion-chip')
                .forEach(c => c.classList.remove('active'));
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
          const input = this.container?.querySelector(
            '#name'
          ) as HTMLInputElement;
          if (input) {
            input.addEventListener('input', () => {
              this.updateNextButtonState(input.value.trim().length > 0);
              chipsContainer
                .querySelectorAll('.wizard-suggestion-chip')
                .forEach(c => c.classList.remove('active'));
            });
            this.updateNextButtonState(input.value.trim().length > 0);
          }
        }, 0);

        return el;
      },
      validate: () => {
        const input = this.container?.querySelector(
          '#name'
        ) as HTMLInputElement;
        return !!input && input.value.trim().length > 0;
      },
      collect: () => {
        const nameInput = this.container?.querySelector(
          '#name'
        ) as HTMLInputElement;
        if (nameInput) this.profileData.name = nameInput.value.trim();
      },
    };
  }

  private createAvatarStep(): WizardStep {
    return {
      id: 'avatar',
      title: 'Avatar',
      required: true,
      render: () => {
        const el = document.createElement('div');
        this.renderStepHeader(
          el,
          'Add a Profile Picture',
          'Upload your own or choose one below.'
        );

        // Upload section
        const uploadSection = document.createElement('div');
        uploadSection.className = 'wizard-avatar-upload-section';

        this.avatarUploader = new ImageUploader({
          ...(this.profileData.picture && {
            currentUrl: this.profileData.picture,
          }),
          onUploadSuccess: url => {
            this.profileData.picture = url;
            this.updateNextButtonState(true);
            this.container
              ?.querySelectorAll('.wizard-default-avatar')
              .forEach(a => a.classList.remove('active'));
          },
          mediaType: 'avatar',
          className: 'wizard-avatar-uploader',
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
      collect: () => {},
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
        grid
          .querySelectorAll('.wizard-default-avatar')
          .forEach(a => a.classList.remove('active'));
        avatarBtn.classList.add('active');
        // Update uploader preview
        const preview = this.container?.querySelector(
          '.wizard-avatar-upload-section [data-preview]'
        ) as HTMLElement;
        if (preview)
          preview.style.backgroundImage = `url('${escapeCssUrl(url)}')`;
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
        this.renderStepHeader(
          el,
          'Tell Us About Yourself',
          'A short bio helps others get to know you. You can always change this later.'
        );

        const bioField = renderBioField(this.profileData.about || '');
        el.appendChild(bioField);

        // Static info box: tells the user which DM inbox relays they start
        // with, and that these are changeable later. Replaces the previous
        // dynamic faith-based relay preview.
        const inboxInfo = document.createElement('div');
        inboxInfo.className = 'wizard-info-box wizard-inbox-info';
        inboxInfo.innerHTML = `
          <strong>Your DM inbox relays</strong>
          <p>
            <span class="wizard-inbox-info__relay">relay.0xchat.com</span>
            <span class="wizard-inbox-info__relay">auth.nostr1.com</span>
          </p>
          <p class="wizard-inbox-info__note">Changeable anytime under Settings &rarr; Relays.</p>
        `;
        el.appendChild(inboxInfo);

        return el;
      },
      validate: () => true,
      collect: () => {
        const textarea = this.container?.querySelector(
          '#about'
        ) as HTMLTextAreaElement;
        if (textarea) this.profileData.about = textarea.value.trim();
      },
    };
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
      collect: () => {},
    };
  }

  private renderPackGrid(el: HTMLElement): void {
    const heading = document.createElement('h2');
    heading.textContent = 'Find People to Follow';
    el.appendChild(heading);

    const intro = document.createElement('p');
    intro.className = 'wizard-intro';
    intro.textContent =
      'Time to fill your timeline with interesting content. Browse the packs below and follow the people that interest you.';
    el.appendChild(intro);

    const subIntro = document.createElement('p');
    subIntro.className = 'wizard-intro';
    subIntro.innerHTML =
      "<em>This is just a start, you'll discover more accounts over time.</em>";
    el.appendChild(subIntro);

    // Duplicate the wizard navigation above the (potentially long) pack list
    // so users can continue without scrolling all the way to the bottom.
    const topNav = this.renderNavigation(this.steps[this.currentStepIndex]!);
    topNav.classList.add('wizard-nav--top');
    el.appendChild(topNav);

    if (this.followedPubkeys.size > 0) {
      const badge = document.createElement('p');
      badge.className = 'wizard-follow-count';
      badge.textContent = `Following ${this.followedPubkeys.size} account${this.followedPubkeys.size !== 1 ? 's' : ''}`;
      el.appendChild(badge);
    }

    const grid = document.createElement('div');
    grid.className = 'follow-packs__grid nn-card-grid';

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
    credit.innerHTML =
      'Follow Packs by <a href="https://github.com/callebtc/following.space" target="_blank" rel="noopener">calle\'s following.space</a>';
    el.appendChild(credit);
  }

  private renderPackCards(grid: HTMLElement): void {
    grid.innerHTML = '';

    if (this.followPacks.length === 0) {
      grid.innerHTML =
        '<p class="wizard-intro">No follow packs found. You can skip this step and find people later.</p>';
      return;
    }

    this.followPacks.forEach((pack, index) => {
      const card = document.createElement('div');
      card.className = 'nn-card';
      card.addEventListener('click', () => {
        this.followPackView = 'detail';
        this.selectedPackIndex = index;
        this.renderCurrentStep();
        // Load profiles for this pack
        this.loadPackProfiles(index);
      });

      const coverWrap = document.createElement('div');
      coverWrap.className = pack.coverImage
        ? 'nn-card__media'
        : 'nn-card__media nn-card__media--empty';
      if (pack.coverImage) {
        const img = document.createElement('img');
        img.src = pack.coverImage;
        img.alt = pack.title;
        coverWrap.appendChild(img);
      }
      card.appendChild(coverWrap);

      const content = document.createElement('div');
      content.className = 'nn-card__content';
      content.innerHTML = `
        <h3>${escapeHtml(pack.title)}</h3>
        <div class="meta">
          <span>${pack.userPubkeys.length} users</span>
        </div>
      `;
      card.appendChild(content);

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
      const cover = document.createElement('img');
      cover.className = 'follow-packs__detail-cover';
      cover.src = pack.coverImage;
      cover.alt = pack.title;
      el.appendChild(cover);
    }

    // Title + description
    const header = document.createElement('div');
    header.className = 'follow-packs__detail-header';
    header.innerHTML = `
      <h2 class="follow-packs__detail-title">${escapeHtml(pack.title)}</h2>
      ${pack.description ? `<p class="follow-packs__detail-desc">${escapeHtml(pack.description)}</p>` : ''}
    `;
    el.appendChild(header);

    // Follow All button
    const allFollowed = pack.userPubkeys.every(pk =>
      this.followedPubkeys.has(pk)
    );
    const followAllBtn = document.createElement('button');
    followAllBtn.className = `btn btn--large ${allFollowed ? 'btn--passive' : ''}`;
    followAllBtn.textContent = allFollowed
      ? 'Following All'
      : `Follow All (${pack.userPubkeys.length})`;
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
    userList.className = 'ui-list follow-packs__members';

    pack.userPubkeys.forEach(pubkey => {
      const profile = pack.userProfiles?.get(pubkey);
      const isFollowed = this.followedPubkeys.has(pubkey);
      const username = profile?.name || `${pubkey.slice(0, 12)}...`;

      const row = document.createElement('div');
      row.className = 'ui-list__item follow-packs__member-item';

      row.innerHTML = `
        <div class="follow-packs__member-avatar profile-pic-container">
          <img class="profile-pic profile-pic--medium" src="${escapeHtmlAttr(profile?.picture || '')}" alt="${escapeHtml(username)}" />
        </div>
        <div class="follow-packs__member-info">
          <div class="follow-packs__member-name">${escapeHtml(username)}</div>
        </div>
      `;

      const followBtn = document.createElement('button');
      followBtn.className = `btn btn--medium follow-packs__member-action-btn ${isFollowed ? 'btn--passive' : ''}`;
      followBtn.textContent = isFollowed ? 'Following' : 'Follow';
      followBtn.addEventListener('click', e => {
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
      const { NostrTransport } = await import(
        '../../services/transport/NostrTransport'
      );
      const { RelayConfig } = await import('../../services/RelayConfig');
      const transport = NostrTransport.getInstance();
      const relays = RelayConfig.getInstance().getAggregatorRelays();

      const events = await transport.fetch(
        relays,
        [{ kinds: [39089 as any], limit: 50 }],
        8000,
        false,
        'AccountSetup'
      );

      this.followPacks = filterFollowPacks(
        events.map(e => parseFollowPackEvent(e))
      );

      this.followPacksLoaded = true;
    } catch {
      this.followPacksLoaded = true;
      this.followPacks = [];
    }
  }

  private async loadPackProfiles(packIndex: number): Promise<void> {
    const pack = this.followPacks[packIndex];
    if (!pack || pack.userProfiles) return;

    try {
      const { UserProfileService } = await import(
        '../../services/UserProfileService'
      );
      const profileService = UserProfileService.getInstance();
      const profiles = await profileService.getUserProfiles(pack.userPubkeys);

      pack.userProfiles = new Map();
      profiles.forEach((profile, pubkey) => {
        const entry: { name?: string; picture?: string; about?: string } = {};
        const displayName =
          profile.name || profile.display_name || profile.username;
        if (displayName) entry.name = displayName;
        if (profile.picture) entry.picture = profile.picture;
        if (profile.about) entry.about = profile.about;
        pack.userProfiles!.set(pubkey, entry);
      });

      // Re-render if still viewing this pack
      if (
        this.followPackView === 'detail' &&
        this.selectedPackIndex === packIndex
      ) {
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
      required: true,
      render: () => {
        const el = document.createElement('div');
        this.renderStepHeader(
          el,
          'Lightning Wallet',
          'Set up a Lightning wallet to send and receive Bitcoin tips (Zaps) on Nostr. This is optional, you can set it up later in Settings.'
        );

        // Already configured?
        if (this.profileData.lud16) {
          const done = document.createElement('div');
          done.className = 'wizard-lightning-done';
          done.innerHTML = `
            <p class="wizard-intro">Lightning address configured: <strong>${escapeHtml(this.profileData.lud16)}</strong></p>
          `;
          el.appendChild(done);
          return el;
        }

        // Step 1: Open Rizful
        const openSection = document.createElement('div');
        openSection.className = 'wizard-lightning-section';
        openSection.innerHTML = `
          <p><strong>How it works:</strong></p>
          <ol class="wizard-lightning-steps">
            <li>Open <a href="https://rizful.com" target="_blank" rel="noopener">rizful.com</a></li>
            <li>Create an account at <a href="https://rizful.com/create-account" target="_blank" rel="noopener">rizful.com/create-account</a></li>
            <li>Wait for the confirmation email and click "Verify your account" in it</li>
            <li>You'll land on the Rizful verification page. Confirm by clicking "Verify Account" there</li>
            <li>Come back here and click the "Open Rizful" button below</li>
          </ol>
          <button class="btn btn--large" data-action="open-rizful">Open Rizful</button>
        `;
        el.appendChild(openSection);

        openSection
          .querySelector('[data-action="open-rizful"]')
          ?.addEventListener('click', async () => {
            try {
              const { PlatformService } = await import(
                '../../services/PlatformService'
              );
              const _p = PlatformService.getInstance();
              if (_p.isElectron) {
                await window.electronAPI!.openExternal(
                  'https://rizful.com/nostr_onboarding_auth_token/get_token'
                );
              } else {
                window.open(
                  'https://rizful.com/nostr_onboarding_auth_token/get_token',
                  '_blank',
                  'noopener,noreferrer'
                );
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
            <button class="btn btn--large" data-action="redeem-code">Connect</button>
          </div>
          <div class="wizard-lightning-status" data-lightning-status></div>
        `;
        el.appendChild(codeSection);

        const redeemBtn = codeSection.querySelector(
          '[data-action="redeem-code"]'
        ) as HTMLButtonElement;
        const statusEl = codeSection.querySelector(
          '[data-lightning-status]'
        ) as HTMLElement;

        redeemBtn?.addEventListener('click', async () => {
          if (redeemInProgress) return;

          const codeInput = codeSection.querySelector(
            '#wizard-rizful-code'
          ) as HTMLInputElement;
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
            const response = await fetch(
              'https://rizful.com/nostr_onboarding_auth_token/post_for_secrets',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  secret_code: code,
                  nostr_public_key: user.pubkey,
                }),
              }
            );

            if (!response.ok) {
              throw new Error(`Request failed (${response.status})`);
            }

            const data = (await response.json()) as {
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

            statusEl.innerHTML = `Connected! Your Lightning address: <strong>${escapeHtml(data.lightning_address)}</strong>`;
            statusEl.classList.add('wizard-lightning-status--success');
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
      validate: () => !!this.profileData.lud16,
      collect: () => {},
      confirmSkip: () => this.confirmSkipWallet(),
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
            <div class="wizard-done-avatar" style="background-image: url('${escapeCssUrl(this.profileData.picture || '')}')"></div>
            <h3>${escapeHtml(this.profileData.name || '')}</h3>
            <p class="wizard-done-username">@${escapeHtml(this.profileData.name || '')}</p>
            ${this.profileData.about ? `<p class="wizard-done-bio">${escapeHtml(this.profileData.about)}</p>` : ''}
            <p class="wizard-done-bio">${this.selectedRelays.length} relay${this.selectedRelays.length !== 1 ? 's' : ''}, ${this.inboxRelays.filter(r => r.selected).length} inbox relay${this.inboxRelays.filter(r => r.selected).length !== 1 ? 's' : ''}</p>
            ${this.followedPubkeys.size > 0 ? `<p class="wizard-done-bio">Following ${this.followedPubkeys.size} account${this.followedPubkeys.size !== 1 ? 's' : ''}</p>` : ''}
            ${this.profileData.lud16 ? `<p class="wizard-done-bio">⚡ ${escapeHtml(this.profileData.lud16)}</p>` : ''}
          </div>
          <div class="wizard-nav l-row--split" style="border-top: none;">
            <button class="btn btn--large btn--passive" data-wizard-action="prev"><</button>
            <button class="btn btn--large" data-wizard-action="finish"${this.publishing ? ' disabled' : ''}>
              <span data-finish-text>Save & Go to Timeline</span>
              <span data-finish-spinner style="display: none;">Publishing...</span>
            </button>
          </div>
        `;

        el.querySelector('[data-wizard-action="prev"]')?.addEventListener(
          'click',
          () => this.goToPreviousStep()
        );
        el.querySelector('[data-wizard-action="finish"]')?.addEventListener(
          'click',
          () => this.handleFinish()
        );

        return el;
      },
      validate: () => true,
      collect: () => {},
    };
  }

  // ─── Publish & Finish ──────────────────────────────────────

  private async handleFinish(): Promise<void> {
    if (this.publishing) return;
    this.publishing = true;

    const finishBtn = this.container?.querySelector(
      '[data-wizard-action="finish"]'
    ) as HTMLButtonElement;
    const finishText = this.container?.querySelector(
      '[data-finish-text]'
    ) as HTMLElement;
    const finishSpinner = this.container?.querySelector(
      '[data-finish-spinner]'
    ) as HTMLElement;

    if (finishBtn) finishBtn.disabled = true;
    if (finishText) finishText.style.display = 'none';
    if (finishSpinner) finishSpinner.style.display = 'inline';

    try {
      // 1. Publish profile (Kind-0)
      this.updateFinishStatus(finishSpinner, 'Publishing profile...');
      const result = await (this.profileApi?.updateProfile(this.profileData) ??
        Promise.resolve(null));
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
        this.updateFinishStatus(
          finishSpinner,
          `Following ${this.followedPubkeys.size} accounts...`
        );
        const { followUser } = await import('../../lists/follows');
        this.followedPubkeys.forEach(pubkey => followUser(pubkey, false));
      }

      // Update ProfileService cache so profile is immediately available
      const currentPubkey = this.authService.getCurrentUser()?.pubkey;
      if (currentPubkey) {
        const cachedProfile: import('../../services/UserProfileService').UserProfile =
          { pubkey: currentPubkey, lastUpdated: Date.now() };
        if (this.profileData.name) cachedProfile.name = this.profileData.name;
        if (this.profileData.display_name)
          cachedProfile.display_name = this.profileData.display_name;
        if (this.profileData.picture)
          cachedProfile.picture = this.profileData.picture;
        if (this.profileData.about)
          cachedProfile.about = this.profileData.about;
        if (this.profileData.lud16)
          cachedProfile.lud16 = this.profileData.lud16;
        UserProfileService.getInstance().setCachedProfile(
          currentPubkey,
          cachedProfile
        );
      }

      // Done
      if (currentPubkey) {
        this.eventBus.emit('profile:updated', { pubkey: currentPubkey });
      }

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

    const settingsApi =
      ModuleLoader.getInstance().getApi<SettingsModuleApi>('settings');
    const relayTags = settingsApi?.relayInfosToTags(relayInfos) ?? [];
    const unsignedEvent = {
      kind: 10002,
      created_at: Math.floor(Date.now() / 1000),
      tags: relayTags,
      content: '',
      pubkey: user.pubkey,
    };

    const signedEvent = await this.authService.signEvent(unsignedEvent);

    // Orchestrator emits via `publishEverywhere` so the fresh NIP-65 lands
    // on every reachable relay including aggregators — required for
    // discovery from any other client on the network.
    await settingsApi?.publishRelayList(relayInfos, signedEvent);

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

    const { NostrTransport } = await import(
      '../../services/transport/NostrTransport'
    );
    const transport = NostrTransport.getInstance();
    // kind:10050 is discovery metadata — broadcast everywhere so other
    // NIP-17 senders can find this user's inbox-set from any relay.
    await transport.publishEverywhere(signedEvent);

    // Register inbox relays in RelayConfig so DMService can find them
    const { RelayConfig } = await import('../../services/RelayConfig');
    const relayConfig = RelayConfig.getInstance();
    selected.forEach(r =>
      relayConfig.addRelay({
        url: r.url,
        types: ['inbox'],
        isPaid: false,
        requiresAuth: true,
        isActive: true,
      })
    );
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
  private renderStepHeader(
    parent: HTMLElement,
    heading: string,
    intro: string
  ): void {
    const h = document.createElement('h2');
    h.textContent = heading;
    parent.appendChild(h);

    const p = document.createElement('p');
    p.className = 'wizard-intro';
    p.textContent = intro;
    parent.appendChild(p);
  }
}
