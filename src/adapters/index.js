import { config } from '../config.js';
import * as rmapi from './rmapi.js';
import * as ssh from './ssh.js';
import * as fixture from './fixture.js';

const adapters = { rmapi, ssh, fixture };

export function source() {
  const a = adapters[config.source.adapter];
  if (!a) throw new Error(`Unknown source adapter "${config.source.adapter}" (expected: ${Object.keys(adapters).join(', ')})`);
  return a;
}
