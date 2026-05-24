import { PetnameService } from '../services/PetnameService';

export function getPetname(pubkey: string): string | null {
  return PetnameService.getInstance().getPetname(pubkey);
}
