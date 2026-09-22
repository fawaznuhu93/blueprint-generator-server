const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const OpenAI = require('openai');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));

// =====================
// FEATURE FLAGS
// =====================
const ENABLE_TEXT_AI = process.env.ENABLE_TEXT_AI === 'true';
const ENABLE_IMAGE_AI = process.env.ENABLE_IMAGE_AI === 'true';

// =====================
// AI CLIENTS
// =====================
const aiClient = new OpenAI({
  apiKey: process.env.AI_API_KEY || 'not-configured',
  baseURL: process.env.AI_BASE_URL || 'https://agentrouter.org/v1',
  timeout: 8000,
  defaultHeaders: {
    'User-Agent': process.env.AI_USER_AGENT || 'codex_cli_rs/0.101.0',
    'Originator': 'codex_cli_rs',
    'Version': '0.101.0'
  }
});

const groqClient = process.env.GROQ_API_KEY ? new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
  timeout: 15000
}) : null;

const keylessClient = new OpenAI({
  apiKey: 'not-needed',
  baseURL: process.env.KEYLESS_BASE_URL || 'https://keylessai.thryx.workers.dev/v1',
  timeout: 8000
});

console.log('\n🤖 AI Configuration:');
console.log('   Text AI:', ENABLE_TEXT_AI ? '✅ ENABLED' : '⏸️  DISABLED (using templates)');
console.log('   Image AI:', ENABLE_IMAGE_AI ? '✅ ENABLED' : '⏸️  DISABLED (using SVG render)');
console.log('   Providers:', [
  groqClient ? 'Groq' : null,
  'KeylessAI',
  'Agent Router'
].filter(Boolean).join(' → '));
console.log('');

// =====================
// TEXT PROVIDER CHAIN
// =====================
async function callTextAI(messages, options = {}) {
  if (!ENABLE_TEXT_AI) {
    return { success: false, error: 'Text AI disabled' };
  }

  const { temperature = 0.2, max_tokens = 4000 } = options;

  // Provider 1: Groq (if configured)
  if (groqClient) {
    try {
      console.log('📡 Provider 1: Groq...');
      const response = await groqClient.chat.completions.create({
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        messages,
        temperature,
        max_tokens
      });
      const content = response.choices?.[0]?.message?.content;
      if (content && content.length > 10) {
        console.log('✅ Groq success');
        return { success: true, content, provider: 'groq' };
      }
    } catch (err) {
      console.log('❌ Groq failed:', err.message);
    }
  }

  // Provider 2: KeylessAI
  try {
    console.log('📡 Provider 2: KeylessAI...');
    const response = await keylessClient.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      temperature,
      max_tokens: Math.min(max_tokens, 2000)
    });
    const content = response.choices?.[0]?.message?.content;
    if (content && content.length > 10) {
      console.log('✅ KeylessAI success');
      return { success: true, content, provider: 'keylessai' };
    }
  } catch (err) {
    console.log('❌ KeylessAI failed:', err.message);
  }

  // Provider 3: Agent Router
  try {
    console.log('📡 Provider 3: Agent Router...');
    const response = await aiClient.chat.completions.create({
      model: process.env.AI_MODEL || 'glm-5.3',
      messages,
      temperature,
      max_tokens
    });
    const content = response.choices?.[0]?.message?.content;
    if (content && content.length > 10) {
      console.log('✅ Agent Router success');
      return { success: true, content, provider: 'agent-router' };
    }
  } catch (err) {
    console.log('❌ Agent Router failed:', err.message);
  }

  return { success: false, error: 'All text providers failed' };
}

// =====================
// HEALTH
// =====================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    text_ai_enabled: ENABLE_TEXT_AI,
    image_ai_enabled: ENABLE_IMAGE_AI,
    template_mode: !ENABLE_TEXT_AI,
    providers: [
      groqClient ? 'groq' : null,
      'keylessai',
      'agent-router'
    ].filter(Boolean),
    model: process.env.AI_MODEL
  });
});

// =====================
// TEST AI
// =====================
app.get('/api/test-ai', async (req, res) => {
  if (!ENABLE_TEXT_AI) {
    return res.json({
      success: true,
      mode: 'template',
      message: 'Text AI is disabled. Using template-based generation.',
      hint: 'Set ENABLE_TEXT_AI=true in .env to activate AI'
    });
  }

  console.log('\n🧪 Testing AI...');
  const result = await callTextAI([
    { role: 'user', content: 'Reply with exactly: AI is working!' }
  ], { max_tokens: 50 });

  if (result.success) {
    res.json({ success: true, provider: result.provider, response: result.content });
  } else {
    res.json({ success: false, error: result.error, fallback: 'template' });
  }
});

// =====================
// GENERATE BLUEPRINT
// =====================
app.post('/api/generate-blueprint', async (req, res) => {
  try {
    const { buildingData, country, professionalMode, customizations } = req.body;
    const bedrooms = buildingData?.bedrooms || buildingData?.roomCount?.bedrooms || 3;

    const normalizedData = {
      buildingType: buildingData?.buildingType || 'bungalow',
      bedrooms,
      guestToilet: buildingData?.guestToilet || { hasGuestToilet: false, count: 0 },
      landSize: buildingData?.landSize || { width: 50, depth: 60, unit: 'feet' },
      description: buildingData?.description || '',
      soilType: buildingData?.soilType || 'not-sure'
    };

    console.log('\n📋 === NEW BLUEPRINT REQUEST ===');
    console.log('🏠 Building:', normalizedData.buildingType);
    console.log('🌍 Country:', country);
    console.log('🛏️ Bedrooms:', normalizedData.bedrooms);
    console.log('⚙️  Mode:', ENABLE_TEXT_AI ? 'AI + template fallback' : 'Template only');

    // If AI is disabled → use template immediately (fast!)
    if (!ENABLE_TEXT_AI) {
      const template = generateTemplateBlueprint(normalizedData, country, customizations);
      console.log(`🎨 Template generated: ${template.rooms.length} rooms`);
      return res.json({
        success: true,
        data: template,
        source: 'template',
        note: 'AI disabled — using template-based generation'
      });
    }

    // AI enabled → try AI, fallback to template
    const prompt = buildBlueprintPrompt(normalizedData, country);

    const result = await callTextAI([
      {
        role: 'system',
        content: 'You are a professional architect. Return ONLY valid JSON. No markdown. Start with { and end with }.'
      },
      { role: 'user', content: prompt }
    ], { temperature: 0.2, max_tokens: 4000 });

    if (!result.success) {
      console.log('🔄 AI failed → template fallback');
      return res.json({
        success: true,
        data: generateTemplateBlueprint(normalizedData, country, customizations),
        source: 'template-fallback'
      });
    }

    // Parse AI response
    let blueprint;
    try {
      let cleaned = result.content.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n/, '').replace(/\n```$/, '');
      }
      blueprint = JSON.parse(cleaned);
    } catch (e) {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      blueprint = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    }

    if (!blueprint?.rooms?.length) {
      console.log('⚠️ Invalid AI JSON → template fallback');
      return res.json({
        success: true,
        data: generateTemplateBlueprint(normalizedData, country, customizations),
        source: 'template-fallback'
      });
    }

    // Ensure ensuite bathrooms
    const bedCount = blueprint.rooms.filter(r => r.type === 'bedroom').length;
    const bathCount = blueprint.rooms.filter(r => r.type === 'bathroom').length;
    if (bedCount > bathCount) {
      for (let i = 0; i < bedCount - bathCount; i++) {
        blueprint.rooms.push({
          id: `room-extra-bath-${i}`,
          name: `Bathroom ${bathCount + i + 1}`,
          type: 'bathroom',
          width: 6, depth: 8, area: 48,
          position: { x: 60 + (i * 15), y: 40 },
          color: '#06b6d4',
          doors: [{ wall: 'west', position: 0.5, width: 2.5 }],
          windows: []
        });
      }
    }

    console.log(`🎉 AI generated (${result.provider}): ${blueprint.rooms.length} rooms`);
    res.json({
      success: true,
      data: blueprint,
      source: 'ai',
      provider: result.provider
    });

  } catch (error) {
    console.error('❌ Generation error:', error.message);
    try {
      const fallback = generateTemplateBlueprint(
        req.body.buildingData,
        req.body.country,
        req.body.customizations
      );
      res.json({ success: true, data: fallback, source: 'template-fallback' });
    } catch (fallbackError) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// =====================
// GENERATE BLUEPRINT IMAGE
// =====================
app.post('/api/generate-blueprint-image', async (req, res) => {
  if (!ENABLE_IMAGE_AI) {
    return res.status(200).json({
      success: false,
      disabled: true,
      message: 'Image AI is disabled. Use the SVG renderer in the frontend.',
      hint: 'The frontend SVGBlueprintViewer renders blueprints from JSON — no external image API needed'
    });
  }

  try {
    const { buildingData, country } = req.body;
    const bedrooms = buildingData?.bedrooms || buildingData?.roomCount?.bedrooms || 3;

    console.log('\n🖼️ === AI IMAGE REQUEST ===');

    const prompt = buildImagePrompt(buildingData, country, bedrooms);
    let imageBase64 = null;
    let usedMethod = null;

    // Path 1: Pollinations (retry with backoff)
    if (!imageBase64) {
      console.log('🔧 Pollinations.ai with retry...');
      const encodedPrompt = encodeURIComponent(prompt);
      const seed = Math.floor(Math.random() * 999999);
      const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true&model=flux&seed=${seed}`;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 45000);

          const response = await fetch(pollinationsUrl, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BlueprintGenerator/1.0)' }
          });
          clearTimeout(timeoutId);

          if (response.ok) {
            const buffer = await response.arrayBuffer();
            if (buffer.byteLength > 5000) {
              imageBase64 = Buffer.from(buffer).toString('base64');
              usedMethod = 'pollinations';
              console.log('✅ Image from Pollinations');
              break;
            }
          } else if (response.status === 429) {
            await new Promise(r => setTimeout(r, 3000 * attempt));
          }
        } catch (err) {
          if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      }
    }

    if (!imageBase64) {
      return res.status(503).json({
        success: false,
        error: 'Image generation unavailable',
        fallback: 'svg'
      });
    }

    res.json({
      success: true,
      imageBase64: `data:image/png;base64,${imageBase64}`,
      method: usedMethod
    });

  } catch (error) {
    console.error('❌ Image error:', error.message);
    res.status(500).json({ success: false, error: error.message, fallback: 'svg' });
  }
});

// =====================
// PROMPTS
// =====================
function buildBlueprintPrompt(data, country) {
  const { bedrooms, landSize, soilType, guestToilet, description, buildingType } = data;
  return `Generate a professional architectural blueprint as valid JSON.

PROJECT:
- Type: ${buildingType}
- Country: ${country}
- Land: ${landSize.width}ft × ${landSize.depth}ft
- Bedrooms: ${bedrooms} (EACH MUST have attached bathroom)
- Guest Toilet: ${guestToilet.hasGuestToilet ? `Yes (${guestToilet.count})` : 'No'}
- Soil: ${soilType}
- Vision: "${description}"

Return ONLY this JSON:
{
  "buildingType": "${buildingType}",
  "country": "${country}",
  "totalArea": 2000,
  "dimensions": { "width": ${Math.round(landSize.width * 0.9)}, "depth": ${Math.round(landSize.depth * 0.9)} },
  "rooms": [
    {
      "id": "room-0",
      "name": "Living Room",
      "type": "living",
      "width": 16,
      "depth": 20,
      "area": 320,
      "position": { "x": 10, "y": 10 },
      "color": "#3b82f6",
      "doors": [{ "wall": "south", "position": 0.5, "width": 3 }],
      "windows": [{ "wall": "north", "position": 0.5, "width": 6 }]
    }
  ],
  "layout": "professional",
  "unit": "feet"
}`;
}

function buildImagePrompt(buildingData, country, bedrooms) {
  const buildingType = buildingData?.buildingType || 'house';
  const landW = buildingData?.landSize?.width || 50;
  const landD = buildingData?.landSize?.depth || 60;
  return `Professional architectural blueprint floor plan, top-down view, of a ${buildingType} with ${bedrooms} bedrooms on ${landW} x ${landD} feet plot in ${country}. Classic blueprint style, deep blue background, white technical lines, room labels, dimensions, door swings, window symbols, title block, north arrow, scale bar. Engineering-quality technical drawing.`;
}

// =====================
// TEMPLATE GENERATOR (Always Reliable)
// =====================
function generateTemplateBlueprint(data, country, customizations) {
  const bedrooms = data?.bedrooms || 3;
  const landWidth = data?.landSize?.width || 50;
  const landDepth = data?.landSize?.depth || 60;
  const guestToilet = data?.guestToilet;
  const unit = country === 'US' || country === 'CA' ? 'feet' : 'meters';

  const rooms = [];
  let x = 10, y = 10;

  // Living Room
  rooms.push({
    id: 'room-living', name: 'Living Room', type: 'living',
    width: 16, depth: 20, area: 320,
    position: { x, y }, color: '#3b82f6',
    doors: [{ wall: 'south', position: 0.5, width: 3 }],
    windows: [{ wall: 'north', position: 0.5, width: 6 }]
  });
  x += 21;

  // Kitchen
  rooms.push({
    id: 'room-kitchen', name: 'Kitchen', type: 'kitchen',
    width: 12, depth: 15, area: 180,
    position: { x, y }, color: '#f59e0b',
    doors: [{ wall: 'south', position: 0.5, width: 3 }],
    windows: [{ wall: 'north', position: 0.5, width: 4 }]
  });
  x += 17;

  // Dining
  rooms.push({
    id: 'room-dining', name: 'Dining Area', type: 'dining',
    width: 12, depth: 14, area: 168,
    position: { x, y }, color: '#ec4899',
    doors: [{ wall: 'south', position: 0.5, width: 3 }],
    windows: [{ wall: 'north', position: 0.5, width: 4 }]
  });

  // Bedrooms with ensuite
  x = 10; y = 35;
  for (let i = 0; i < bedrooms; i++) {
    const isMaster = i === 0;
    const bw = isMaster ? 14 : 12;
    const bd = isMaster ? 16 : 12;

    rooms.push({
      id: `room-bed-${i}`,
      name: isMaster ? 'Master Bedroom' : `Bedroom ${i + 1}`,
      type: 'bedroom',
      width: bw, depth: bd, area: bw * bd,
      position: { x, y }, color: '#8b5cf6',
      doors: [{ wall: 'south', position: 0.5, width: 3 }],
      windows: [{ wall: 'north', position: 0.5, width: 4 }]
    });

    rooms.push({
      id: `room-bath-${i}`,
      name: isMaster ? 'Master Bath' : `Bathroom ${i + 1}`,
      type: 'bathroom',
      width: 6, depth: 8, area: 48,
      position: { x: x + bw + 2, y }, color: '#06b6d4',
      doors: [{ wall: 'west', position: 0.5, width: 2.5 }],
      windows: []
    });

    x += bw + 10;
    if (x > 50) { x = 10; y += 20; }
  }

  // Guest toilet
  if (guestToilet?.hasGuestToilet) {
    rooms.push({
      id: 'room-guest-toilet', name: 'Guest Toilet', type: 'bathroom',
      width: 5, depth: 7, area: 35,
      position: { x: 10, y: y + 20 }, color: '#06b6d4',
      doors: [{ wall: 'east', position: 0.5, width: 2.5 }],
      windows: []
    });
  }

  // Apply professional customizations
  if (customizations?.roomSizes) {
    rooms.forEach(room => {
      const custom = customizations.roomSizes[room.type];
      if (custom) {
        room.width = custom.width || room.width;
        room.depth = custom.depth || room.depth;
        room.area = room.width * room.depth;
      }
    });
  }

  const totalArea = rooms.reduce((sum, r) => sum + r.area, 0);

  return {
    buildingType: data?.buildingType || 'bungalow',
    country,
    totalArea: Math.round(totalArea * 10) / 10,
    dimensions: { width: Math.round(landWidth * 0.9), depth: Math.round(landDepth * 0.9) },
    rooms,
    layout: 'professional',
    unit,
    createdAt: new Date().toISOString()
  };
}

// =====================
// START
// =====================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/api/health`);
  console.log(`🧪 Test: http://localhost:${PORT}/api/test-ai\n`);
});