Upstream: https://github.com/nxg-org/mineflayer-custom-pvp
Revision: 71e2708acf26e98ce8f65207a27a5f0c7b0db8c9
Author: generel_schwerz
License declared in upstream package.json: GPL-3.0; license text in LICENSE.

src/lib/CombatStrafe.js adapts circle direction from SwordPvp.doStrafe in
src/sword/swordpvp.ts. Local integration adds terrain, range and action-owner
checks; angle normalization handles the -pi/pi boundary.
The complete plugin is not installed. Its packet criticals and velocity
manipulation are not imported. The existing mineflayer-pvp controls strikes
and shield timing, with a local guard against overlapping attack sequences.
