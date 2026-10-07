import { expect, it } from 'vitest';
import { getActivityDeviceId, ActivityDeviceUnavailableError } from './device';
it('requires persistent native storage and never invents an in-memory identity after failure',async()=>{
  await expect(getActivityDeviceId({open(){throw Error('No storage');}} as unknown as IDBFactory)).rejects.toBeInstanceOf(ActivityDeviceUnavailableError);
});
