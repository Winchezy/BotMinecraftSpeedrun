// SPDX-License-Identifier: GPL-3.0-only
// Circle direction adapted from generel_schwerz's mineflayer-custom-pvp
// SwordPvp.doStrafe. Source and license: third-party/custom-pvp/.
function circleDirection(target, position) {
    if (!target?.position || !Number.isFinite(target.yaw)) return null;
    const yaw = Math.atan2(-(position.x-target.position.x), -(position.z-target.position.z));
    // Normalize at +/- pi so crossing north doesn't disable the maneuver.
    const diff = Math.atan2(Math.sin(yaw-target.yaw), Math.cos(yaw-target.yaw));
    if (Math.abs(diff) >= Math.PI / 3) return null;
    const circleDir = diff < 0 ? 'right' : 'left';
    return circleDir;
}
module.exports = { circleDirection };
