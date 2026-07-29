/**
 * Seed Lua tool templates that demonstrate branch-aware state
 * using serialize() / deserialize().
 */

import type { IToolTemplateRepository } from '../../repos/ToolTemplateRepository.js';
import { randomUUID } from 'node:crypto';

export const memoryTemplate = {
  name: 'lua_memory',
  configSchema: {},
  code: `Tool = {}
Tool.state = { memories = {} }

function Tool.getDefinition()
  return {
    stateKey = "memory",
    configSchema = {},
    tools = {
      {
        name = "set_memory",
        description = "Store a key-value memory.",
        parameters = {
          type = "object",
          properties = {
            key = { type = "string" },
            value = { type = "string" }
          },
          required = {"key", "value"}
        }
      },
      {
        name = "recall_memory",
        description = "Recall stored memories.",
        parameters = {
          type = "object",
          properties = {
            query = { type = "string" }
          }
        }
      },
      {
        name = "forget_memory",
        description = "Remove a memory by key.",
        parameters = {
          type = "object",
          properties = {
            key = { type = "string" }
          },
          required = {"key"}
        }
      }
    }
  }
end

function Tool.execute(args, context, toolName)
  if toolName == "set_memory" then
    Tool.state.memories[args.key] = args.value
    return { content = "Memory stored: " .. args.key }
  elseif toolName == "recall_memory" then
    local query = args.query or ""
    local results = {}
    for key, value in pairs(Tool.state.memories) do
      if query == "" or string.find(key:lower(), query:lower()) or string.find(value:lower(), query:lower()) then
        table.insert(results, key .. ": " .. value)
      end
    end
    if #results == 0 then
      return { content = "No memories." }
    end
    return { content = table.concat(results, "\\n") }
  elseif toolName == "forget_memory" then
    if Tool.state.memories[args.key] then
      Tool.state.memories[args.key] = nil
      return { content = "Forgot: " .. args.key }
    end
    return { content = "Memory not found: " .. args.key }
  end
  return { content = "Unknown tool: " .. toolName }
end

function Tool.serialize()
  return json.encode(Tool.state)
end

function Tool.deserialize(raw)
  Tool.state = json.decode(raw)
end

return Tool
`,
};

export const todoTemplate = {
  name: 'lua_todo',
  configSchema: {},
  code: `Tool = {}
Tool.state = { todos = {} }

function Tool.getDefinition()
  return {
    stateKey = "todo",
    configSchema = {},
    tools = {
      {
        name = "add_todo",
        description = "Add a new todo item.",
        parameters = {
          type = "object",
          properties = {
            task = { type = "string" }
          },
          required = {"task"}
        }
      },
      {
        name = "list_todos",
        description = "List all todo items.",
        parameters = { type = "object", properties = {} }
      },
      {
        name = "remove_todo",
        description = "Remove a todo by index.",
        parameters = {
          type = "object",
          properties = {
            index = { type = "number" }
          },
          required = {"index"}
        }
      },
      {
        name = "clear_todos",
        description = "Clear all todos.",
        parameters = { type = "object", properties = {} }
      }
    }
  }
end

function Tool.execute(args, context, toolName)
  local chatId = context.chatId or "global"
  if not Tool.state.todos[chatId] then
    Tool.state.todos[chatId] = {}
  end
  local items = Tool.state.todos[chatId]

  if toolName == "add_todo" then
    table.insert(items, args.task)
    return { content = "Added: " .. args.task }
  elseif toolName == "list_todos" then
    if #items == 0 then
      return { content = "No todos." }
    end
    local lines = {}
    for i, task in ipairs(items) do
      table.insert(lines, i .. ". " .. task)
    end
    return { content = table.concat(lines, "\\n") }
  elseif toolName == "remove_todo" then
    local idx = math.floor(args.index)
    if idx >= 1 and idx <= #items then
      local removed = table.remove(items, idx)
      return { content = "Removed: " .. removed }
    end
    return { content = "Invalid index." }
  elseif toolName == "clear_todos" then
    Tool.state.todos[chatId] = {}
    return { content = "Cleared all todos." }
  end
  return { content = "Unknown tool: " .. toolName }
end

function Tool.serialize()
  return json.encode(Tool.state)
end

function Tool.deserialize(raw)
  Tool.state = json.decode(raw)
end

return Tool
`,
};

export const diceTemplate = {
  name: 'lua_dice',
  configSchema: {},
  code: `Tool = {}

function Tool.getDefinition()
  return {
    stateKey = "dice",
    configSchema = {},
    tools = {
      {
        name = "roll_dice",
        description = "Roll dice and return the total result.",
        parameters = {
          type = "object",
          properties = {
            count = { type = "number", description = "Number of dice to roll (default: 1)" },
            sides = { type = "number", description = "Number of sides per die (default: 6)" }
          }
        }
      }
    }
  }
end

function Tool.execute(args, context, toolName)
  local count = math.max(1, math.min(100, math.floor(args.count or 1)))
  local sides = math.max(1, math.min(1000, math.floor(args.sides or 6)))
  local rolls = {}
  local total = 0
  for i = 1, count do
    local roll = math.random(sides)
    table.insert(rolls, roll)
    total = total + roll
  end
  local rollStr = table.concat(rolls, ", ")
  return {
    content = "Rolled " .. count .. "d" .. sides .. ": " .. rollStr .. " = " .. total,
    extra = {
      renderType = "dice",
      diceResult = total,
      diceSides = sides,
      diceCount = count,
      diceRolls = rolls
    }
  }
end

function Tool.serialize()
  return ""
end

function Tool.deserialize(raw)
end

return Tool
`,
};

export const choicesTemplate = {
  name: 'lua_choices',
  configSchema: {},
  code: `Tool = {}

function Tool.getDefinition()
  return {
    stateKey = "choices",
    configSchema = {},
    tools = {
      {
        name = "present_choices",
        description = "Present the user with a list of choices at a decision point. Use this after narrating up to the point where the user must decide what to do next; do not continue the story past the decision. The user's selection arrives as their next message.",
        endsTurn = true,
        parameters = {
          type = "object",
          properties = {
            options = {
              type = "array",
              items = { type = "string" },
              minItems = 2,
              maxItems = 6,
              description = "2-6 short choice labels the user can pick from"
            },
            prompt = { type = "string", description = "Optional lead-in question, e.g. \\"What do you do?\\"" }
          },
          required = {"options"}
        }
      }
    }
  }
end

function Tool.execute(args, context, toolName)
  local options = args.options
  if type(options) ~= "table" or #options < 2 or #options > 6 then
    return { content = "Error: present_choices requires between 2 and 6 options." }
  end
  local choices = {}
  for i, opt in ipairs(options) do
    if type(opt) ~= "string" or opt == "" then
      return { content = "Error: all options must be non-empty strings." }
    end
    table.insert(choices, opt)
  end
  local prompt = ""
  if type(args.prompt) == "string" then
    prompt = args.prompt
  end
  return {
    content = "Presented " .. #choices .. " choices to the user: " .. table.concat(choices, ", "),
    extra = {
      renderType = "choices",
      choicesPrompt = prompt,
      choices = choices
    }
  }
end

function Tool.serialize()
  return ""
end

function Tool.deserialize(raw)
end

return Tool
`,
};

export const timeTemplate = {
  name: 'lua_time',
  configSchema: {},
  code: `Tool = {}

function Tool.getDefinition()
  return {
    stateKey = "time",
    configSchema = {},
    tools = {
      {
        name = "get_time",
        description = "Get the current date and time.",
        parameters = { type = "object", properties = {} }
      }
    }
  }
end

function Tool.execute(args, context, toolName)
  return { content = "Current time: " .. get_time_iso() }
end

function Tool.serialize()
  return ""
end

function Tool.deserialize(raw)
end

return Tool
`,
};

export const encouragementTemplate = {
  name: 'lua_encouragement',
  configSchema: {},
  code: `Tool = {}
Tool.messages = {
  "You're doing great! Keep it up!",
  "Believe in yourself — you've got this!",
  "Every step forward is progress.",
  "Take a deep breath. You're capable and strong.",
  "Challenges are just opportunities in disguise.",
  "Remember: progress, not perfection.",
  "You're more resilient than you know.",
  "One moment at a time. You've got this."
}

function Tool.getDefinition()
  return {
    stateKey = "encouragement",
    configSchema = {},
    tools = {
      {
        name = "encourage",
        description = "Provide a random encouraging message.",
        parameters = { type = "object", properties = {} }
      }
    }
  }
end

function Tool.execute(args, context, toolName)
  local idx = math.random(#Tool.messages)
  return { content = Tool.messages[idx] }
end

function Tool.serialize()
  return ""
end

function Tool.deserialize(raw)
end

return Tool
`,
};

export const npcRegistryTemplate = {
  name: 'lua_npc_registry',
  configSchema: {},
  code: `Tool = {}
Tool.state = { npcs = {} }

function Tool.getDefinition()
  return {
    stateKey = "npc_registry",
    configSchema = {},
    tools = {
      {
        name = "npc_register",
        description = "Create or overwrite an NPC definition (a durable secondary character for this story branch).",
        parameters = {
          type = "object",
          properties = {
            name = { type = "string" },
            description = { type = "string" },
            personality = { type = "string" },
            notes = { type = "string" }
          },
          required = {"name", "description"}
        }
      },
      {
        name = "npc_update",
        description = "Patch fields of an existing NPC definition.",
        parameters = {
          type = "object",
          properties = {
            name = { type = "string" },
            description = { type = "string" },
            personality = { type = "string" },
            notes = { type = "string" }
          },
          required = {"name"}
        }
      },
      {
        name = "npc_get",
        description = "Get the full definition of an NPC.",
        parameters = {
          type = "object",
          properties = {
            name = { type = "string" }
          },
          required = {"name"}
        }
      },
      {
        name = "npc_list",
        description = "List all registered NPCs, one per line, optionally filtered by a substring.",
        parameters = {
          type = "object",
          properties = {
            query = { type = "string" }
          }
        }
      },
      {
        name = "npc_forget",
        description = "Delete an NPC definition.",
        parameters = {
          type = "object",
          properties = {
            name = { type = "string" }
          },
          required = {"name"}
        }
      }
    }
  }
end

local function formatNpc(name, npc)
  local lines = { "Name: " .. name, "Description: " .. (npc.description or "") }
  if npc.personality and npc.personality ~= "" then
    table.insert(lines, "Personality: " .. npc.personality)
  end
  if npc.notes and npc.notes ~= "" then
    table.insert(lines, "Notes: " .. npc.notes)
  end
  return table.concat(lines, "\\n")
end

local function rosterExtra()
  return { renderType = "npc_roster", npcs = Tool.state.npcs }
end

function Tool.execute(args, context, toolName)
  if toolName == "npc_register" then
    Tool.state.npcs[args.name] = {
      description = args.description,
      personality = args.personality or "",
      notes = args.notes or ""
    }
    return { content = "NPC registered: " .. args.name, extra = rosterExtra() }
  elseif toolName == "npc_update" then
    local npc = Tool.state.npcs[args.name]
    if not npc then
      return { content = "NPC not found: " .. args.name }
    end
    if args.description then npc.description = args.description end
    if args.personality then npc.personality = args.personality end
    if args.notes then npc.notes = args.notes end
    return { content = "NPC updated: " .. args.name, extra = rosterExtra() }
  elseif toolName == "npc_get" then
    local npc = Tool.state.npcs[args.name]
    if not npc then
      return { content = "NPC not found: " .. args.name }
    end
    return { content = formatNpc(args.name, npc) }
  elseif toolName == "npc_list" then
    local query = (args.query or ""):lower()
    local names = {}
    for name, npc in pairs(Tool.state.npcs) do
      if query == "" or string.find(name:lower(), query) or string.find((npc.description or ""):lower(), query) then
        table.insert(names, name)
      end
    end
    table.sort(names)
    if #names == 0 then
      return { content = "No NPCs registered." }
    end
    return { content = table.concat(names, "\\n") }
  elseif toolName == "npc_forget" then
    if Tool.state.npcs[args.name] then
      Tool.state.npcs[args.name] = nil
      return { content = "NPC forgotten: " .. args.name, extra = rosterExtra() }
    end
    return { content = "NPC not found: " .. args.name }
  end
  return { content = "Unknown tool: " .. toolName }
end

function Tool.serialize()
  return json.encode(Tool.state)
end

function Tool.deserialize(raw)
  Tool.state = json.decode(raw)
end

return Tool
`,
};

export const mapTemplate = {
  name: 'lua_map',
  configSchema: {},
  code: `Tool = {}
Tool.state = { width = 0, height = 0, grid = {}, player = { x = 0, y = 0 }, explored = {} }

local TERRAINS = { "grass", "forest", "water", "mountain", "wall", "road", "door", "town", "dungeon", "void" }
local TERRAIN_SET = {}
for _, terrain in ipairs(TERRAINS) do
  TERRAIN_SET[terrain] = true
end
local IMPASSABLE = { water = true, wall = true, void = true }
local DIRECTIONS = {
  north = { dx = 0, dy = -1 },
  south = { dx = 0, dy = 1 },
  east = { dx = 1, dy = 0 },
  west = { dx = -1, dy = 0 }
}
local FOG_RADIUS = 2

function Tool.getDefinition()
  return {
    stateKey = "map",
    configSchema = {},
    tools = {
      {
        name = "map_create",
        description = "Create a new tile map for the story world (replaces any existing map). Tiles use a fixed terrain palette: grass, forest, water, mountain, wall, road, door, town, dungeon, void. Coordinates are 0-based. Reveals the fog of war around the start position.",
        parameters = {
          type = "object",
          properties = {
            width = { type = "number", description = "Map width in tiles (1-40)" },
            height = { type = "number", description = "Map height in tiles (1-40)" },
            fill = { type = "string", description = "Terrain every tile starts as (default: grass)" },
            startX = { type = "number", description = "Player start x (default: 0)" },
            startY = { type = "number", description = "Player start y (default: 0)" }
          },
          required = {"width", "height"}
        }
      },
      {
        name = "map_set_tile",
        description = "Paint one tile of the map with a terrain from the palette, optionally naming it as a point of interest (label).",
        parameters = {
          type = "object",
          properties = {
            x = { type = "number" },
            y = { type = "number" },
            terrain = { type = "string", description = "One of: grass, forest, water, mountain, wall, road, door, town, dungeon, void" },
            label = { type = "string", description = "Optional point-of-interest name, e.g. \\"Tavern\\"" }
          },
          required = {"x", "y", "terrain"}
        }
      },
      {
        name = "map_move",
        description = "Move the party one tile in a cardinal direction. Movement into water, wall, or void (or off the map edge) is blocked and leaves the position unchanged. On success, reveals the fog of war around the new position.",
        parameters = {
          type = "object",
          properties = {
            direction = { type = "string", description = "One of: north, south, east, west" }
          },
          required = {"direction"}
        }
      },
      {
        name = "map_teleport",
        description = "Place the party directly on any tile (bounds-checked, but ignores impassable terrain — the narrator's prerogative). Reveals the fog of war around the destination.",
        parameters = {
          type = "object",
          properties = {
            x = { type = "number" },
            y = { type = "number" }
          },
          required = {"x", "y"}
        }
      },
      {
        name = "map_get",
        description = "Get a text description of the party's current position and the adjacent tiles.",
        parameters = { type = "object", properties = {} }
      }
    }
  }
end

local function hasMap()
  return Tool.state.width > 0 and Tool.state.height > 0
end

local function tileAt(x, y)
  if x < 0 or y < 0 or x >= Tool.state.width or y >= Tool.state.height then
    return nil
  end
  local row = Tool.state.grid[y + 1]
  if not row then return nil end
  return row[x + 1]
end

local function tileName(tile)
  if not tile then return "void" end
  local name = tile.t or "void"
  if tile.l and tile.l ~= "" then
    name = name .. " (" .. tile.l .. ")"
  end
  return name
end

local function revealAround(cx, cy)
  for dy = -FOG_RADIUS, FOG_RADIUS do
    for dx = -FOG_RADIUS, FOG_RADIUS do
      local x = cx + dx
      local y = cy + dy
      if x >= 0 and y >= 0 and x < Tool.state.width and y < Tool.state.height then
        Tool.state.explored[x .. "," .. y] = true
      end
    end
  end
end

local function exploredList()
  local keys = {}
  for key in pairs(Tool.state.explored) do
    table.insert(keys, key)
  end
  table.sort(keys)
  return keys
end

local function mapExtra()
  return {
    renderType = "map",
    map = {
      width = Tool.state.width,
      height = Tool.state.height,
      grid = Tool.state.grid,
      player = { x = Tool.state.player.x, y = Tool.state.player.y },
      explored = exploredList()
    }
  }
end

local function surroundingsText(x, y)
  local order = {
    { name = "north", dx = 0, dy = -1 },
    { name = "south", dx = 0, dy = 1 },
    { name = "east", dx = 1, dy = 0 },
    { name = "west", dx = -1, dy = 0 }
  }
  local parts = {}
  for _, d in ipairs(order) do
    local tile = tileAt(x + d.dx, y + d.dy)
    local desc = "map edge"
    if tile then desc = tileName(tile) end
    table.insert(parts, d.name .. ": " .. desc)
  end
  return table.concat(parts, ". ")
end

local function coordArg(value)
  if type(value) ~= "number" then return nil end
  return math.floor(value)
end

function Tool.execute(args, context, toolName)
  if toolName == "map_create" then
    if type(args.width) ~= "number" or type(args.height) ~= "number" then
      return { content = "Error: map_create requires numeric width and height." }
    end
    local width = math.max(1, math.min(40, math.floor(args.width)))
    local height = math.max(1, math.min(40, math.floor(args.height)))
    local fill = args.fill or "grass"
    if type(fill) ~= "string" or not TERRAIN_SET[fill] then
      return { content = "Error: unknown terrain '" .. tostring(fill) .. "'. Valid terrains: " .. table.concat(TERRAINS, ", ") }
    end
    local startX = coordArg(args.startX) or 0
    local startY = coordArg(args.startY) or 0
    if startX < 0 or startY < 0 or startX >= width or startY >= height then
      return { content = "Error: start position (" .. startX .. "," .. startY .. ") is outside a " .. width .. "x" .. height .. " map." }
    end
    Tool.state.width = width
    Tool.state.height = height
    Tool.state.grid = {}
    for y = 1, height do
      local row = {}
      for x = 1, width do
        row[x] = { t = fill }
      end
      Tool.state.grid[y] = row
    end
    Tool.state.player = { x = startX, y = startY }
    Tool.state.explored = {}
    revealAround(startX, startY)
    return {
      content = "Map created: " .. width .. "x" .. height .. " of " .. fill .. ". The party starts at (" .. startX .. "," .. startY .. "). " .. surroundingsText(startX, startY),
      extra = mapExtra()
    }
  elseif toolName == "map_set_tile" then
    if not hasMap() then
      return { content = "Error: no map exists yet. Use map_create first." }
    end
    local x = coordArg(args.x)
    local y = coordArg(args.y)
    local tile = x and y and tileAt(x, y) or nil
    if not tile then
      return { content = "Error: (" .. tostring(x) .. "," .. tostring(y) .. ") is outside the map." }
    end
    local terrain = args.terrain
    if type(terrain) ~= "string" or not TERRAIN_SET[terrain] then
      return { content = "Error: unknown terrain '" .. tostring(terrain) .. "'. Valid terrains: " .. table.concat(TERRAINS, ", ") }
    end
    tile.t = terrain
    if type(args.label) == "string" and args.label ~= "" then
      tile.l = args.label
    end
    return { content = "Tile (" .. x .. "," .. y .. ") set to " .. tileName(tile) .. ".", extra = mapExtra() }
  elseif toolName == "map_move" then
    if not hasMap() then
      return { content = "Error: no map exists yet. Use map_create first." }
    end
    local dir = type(args.direction) == "string" and DIRECTIONS[args.direction] or nil
    if not dir then
      return { content = "Error: direction must be one of north, south, east, west." }
    end
    local px = Tool.state.player.x
    local py = Tool.state.player.y
    local nx = px + dir.dx
    local ny = py + dir.dy
    local target = tileAt(nx, ny)
    if not target then
      return {
        content = "Blocked: the map edge lies " .. args.direction .. ". The party remains at (" .. px .. "," .. py .. ").",
        extra = mapExtra()
      }
    end
    if IMPASSABLE[target.t] then
      return {
        content = "Blocked: " .. tileName(target) .. " lies " .. args.direction .. " and cannot be crossed. The party remains at (" .. px .. "," .. py .. ").",
        extra = mapExtra()
      }
    end
    Tool.state.player = { x = nx, y = ny }
    revealAround(nx, ny)
    return {
      content = "The party moves " .. args.direction .. " to (" .. nx .. "," .. ny .. "): " .. tileName(target) .. ". " .. surroundingsText(nx, ny),
      extra = mapExtra()
    }
  elseif toolName == "map_teleport" then
    if not hasMap() then
      return { content = "Error: no map exists yet. Use map_create first." }
    end
    local x = coordArg(args.x)
    local y = coordArg(args.y)
    local tile = x and y and tileAt(x, y) or nil
    if not tile then
      return { content = "Error: (" .. tostring(x) .. "," .. tostring(y) .. ") is outside the map." }
    end
    Tool.state.player = { x = x, y = y }
    revealAround(x, y)
    return {
      content = "The party appears at (" .. x .. "," .. y .. "): " .. tileName(tile) .. ". " .. surroundingsText(x, y),
      extra = mapExtra()
    }
  elseif toolName == "map_get" then
    if not hasMap() then
      return { content = "No map exists yet. Use map_create first." }
    end
    local px = Tool.state.player.x
    local py = Tool.state.player.y
    return { content = "The party is at (" .. px .. "," .. py .. "): " .. tileName(tileAt(px, py)) .. ". " .. surroundingsText(px, py) }
  end
  return { content = "Unknown tool: " .. toolName }
end

function Tool.serialize()
  return json.encode(Tool.state)
end

function Tool.deserialize(raw)
  Tool.state = json.decode(raw)
end

return Tool
`,
};

/**
 * Reference media template: a Lua port of the builtin forge_image template.
 * Demonstrates the allowNet (fetch) + allowFiles (attachments.create) sandbox
 * capabilities — the model can read this to learn how to author media tools.
 */
export const forgeImageTemplate = {
  name: 'lua_forge_image',
  configSchema: {},
  sandbox: { allowNet: true, allowFiles: true },
  code: `Tool = {}

local ORIENTATION_SIZES = {
  square = { width = 1024, height = 1024 },
  portrait = { width = 832, height = 1216 },
  landscape = { width = 1216, height = 832 },
}

function Tool.getDefinition()
  return {
    stateKey = "forge_image_lua",
    configSchema = {
      type = "object",
      properties = {
        url = { type = "string", description = "Forge API base URL", default = "http://localhost:7860" }
      }
    },
    tools = {
      {
        name = "generate_image_lua",
        description = "Generate an image using Stable Diffusion WebUI Forge. Provide a detailed text prompt. When an image is generated, the result includes a reference in the format {{attachment::ID}} — include this exact reference in your response to display the image.",
        parameters = {
          type = "object",
          properties = {
            prompt = { type = "string", description = "Detailed description of the image to generate." },
            orientation = { type = "string", enum = { "square", "portrait", "landscape" }, description = "Image orientation. Defaults to square." },
            negative_prompt = { type = "string", description = "Things to avoid in the image." }
          },
          required = { "prompt" }
        }
      }
    }
  }
end

function Tool.execute(args, context, toolName)
  local config = (context and context.config) or {}
  local baseUrl = string.gsub(config.url or "http://localhost:7860", "/$", "")

  if not args.prompt or args.prompt == "" then
    return "Error: prompt is required"
  end
  local size = ORIENTATION_SIZES[args.orientation or "square"] or ORIENTATION_SIZES.square

  local res = fetch(baseUrl .. "/sdapi/v1/txt2img", {
    method = "POST",
    headers = { ["Content-Type"] = "application/json" },
    body = json.encode({
      prompt = args.prompt,
      negative_prompt = args.negative_prompt or "",
      width = size.width,
      height = size.height,
      send_images = true,
      save_images = false
    })
  }):await()

  if res.status ~= 200 then
    return "Forge returned " .. tostring(res.status) .. ": " .. (res.body or "(binary response)")
  end

  local data = json.decode(res.body)
  if not data or not data.images or #data.images == 0 then
    return "Forge returned no images."
  end

  local att = attachments.create(data.images[1], "image/png"):await()
  return {
    content = {
      { type = "text", text = "Generated image. To display it in your response, include: {{attachment::" .. att.id .. "}}" },
      { type = "image", source = att.url, mimeType = "image/png" }
    },
    extra = { attachmentId = att.id, attachmentUrl = att.url, attachmentMimeType = att.mimeType }
  }
end

return Tool
`,
};

const SEEDS = [memoryTemplate, todoTemplate, diceTemplate, choicesTemplate, timeTemplate, encouragementTemplate, npcRegistryTemplate, mapTemplate, forgeImageTemplate];

export async function seedToolTemplates(repo: IToolTemplateRepository): Promise<void> {
  const existing = await repo.list();
  const existingNames = new Set(existing.map((e) => e.name));
  for (const seed of SEEDS) {
    if (existingNames.has(seed.name)) continue;
    await repo.create(randomUUID(), seed);
  }
}
