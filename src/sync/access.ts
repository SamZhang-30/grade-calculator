/** UX guard only. The identical policy MUST be enforced in firestore.rules. */
export const SYNC_OWNER_EMAIL = "sam.zhang.official@gmail.com";
export interface SyncAccount {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  providers: string[];
}
export const permittedSyncAccount = (account: SyncAccount): boolean =>
  account.email === SYNC_OWNER_EMAIL && account.emailVerified === true && account.providers.includes("google.com");
