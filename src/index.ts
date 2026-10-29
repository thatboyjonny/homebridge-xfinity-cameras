import type { API } from 'homebridge';

import { XfinityPlatform } from './platform';
import { PLATFORM_NAME } from './settings';

export = (api: API) => {
  api.registerPlatform(PLATFORM_NAME, XfinityPlatform);
};
