Code adapted from https://github.com/mindcraft-bots/mindcraft
Upstream revision: 5f3acc87b479864124173de444f31fa5538f94a6
License: MIT, copyright (c) 2024 Kolby Nottingham; original text in LICENSE.

ResourceAmounts.js adapts calculateLimitingResource and getFuelSmeltOutput
from src/utils/mcdata.js. CraftTask uses the batch limiting approach from
src/agent/library/skills.js craftRecipe; SmeltTask uses its fuel dosing approach.
Local changes: absent inventory entries count as zero, ignore nonpositive
requirements, use Prismarine recipe delta IDs, calculate batches from missing
output units, add sticks and wooden tool fuel, retain existing safe navigation.
This is a selective adaptation, not installation of Mindcraft or its LLM agent.
