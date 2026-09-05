import type {
  ProviderCredentials,
  ProviderIdentity,
  ProviderIdentityPort,
} from '@/application/ports';

// No identity provider is wired, so the declared providerId is taken at face
// value. Swapping this class for one that introspects an OAuth2 token and
// matches its provider claim against the body is the whole change.
export class TrustedProviderIdentityAdapter implements ProviderIdentityPort {
  resolve(_credentials: ProviderCredentials, claimedProviderId: string): Promise<ProviderIdentity> {
    return Promise.resolve({ providerId: claimedProviderId });
  }
}
