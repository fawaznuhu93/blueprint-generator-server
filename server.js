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
// AI CLIENTS (Multi-Provider)
// =====================
const aiClient = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: process.env.AI_BASE_URL || 'https://agentrouter.org/v1',
  timeout: 90000,
  defaultHeaders: {
    'User-Agent': process.env.AI_USER_AGENT || 'codex_cli_rs/0.101.0',
    'Originator': 'codex_cli_rs',
    'Version': '0.101.0'
  }
});

// KeylessAI - no API key needed, works on cloud IPs
const keylessClient = new OpenAI({
  apiKey: 'not-needed',
  baseURL: process.env.KEYLESS_BASE_URL || 'https://keylessai.thryx.workers.dev/v1',
  timeout: 60000
});

// Groq (optional)
const groqClient = process.env.GROQ_API_KEY ? new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
  timeout: 60000
}) : null;

console.log('\n🤖 AI Configuration:');
console.log('   Primary: KeylessAI');
console.log('   Fallback 1: Agent Router (' + (process.env.AI_MODEL || 'glm-5.3') + ')');
console.log('   Fallback 2:', groqClient ? 'Groq' : '❌ not configured');
console.log('');

// =====================
// TEXT PROVIDER FALLBACK CHAIN
// =====================
async function callTextAI(messages, options = {}) {
  const { temperature = 0.2, max_tokens = 4000 } = options;

  // ====================================
  // PROVIDER 1: KeylessAI (works on cloud IPs)
  // ====================================
  try {
    console.log('📡 Text Provider 1: KeylessAI...');
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
    console.log('⚠️ KeylessAI returned empty content');
  } catch (err) {
    console.log('❌ KeylessAI failed:', err.message);
  }

  // ====================================
  // PROVIDER 2: Agent Router (works locally)
  // ====================================
  try {
    console.log('📡 Text Provider 2: Agent Router...');
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
    console.log('⚠️ Agent Router returned empty content');
  } catch (err) {
    console.log('❌ Agent Router failed:', err.message);
  }

  // ====================================
  // PROVIDER 3: Groq (optional)
  // ====================================
  if (groqClient) {
    try {
      console.log('📡 Text Provider 3: Groq...');
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

  return { success: false, error: 'All text providers failed' };
}

// =====================
// HELPER: Extract content safely
// =====================
function extractAIContent(response) {
  if (typeof response === 'string') {
    try { response = JSON.parse(response); } catch (e) { return null; }
  }
  if (!response?.choices || !Array.isArray(response.choices) || response.choices.length === 0) {
    return null;
  }
  const choice = response.choices[0];
  if (!choice?.message) return null;
  const content = choice.message.content;
  if (!content || content.length < 10) {
    const reasoning = choice.message.reasoning_content;
    if (reasoning) {
      console.error('⚠️ Content empty, stuck in reasoning. Length:', reasoning.length);
    }
    return null;
  }
  return content;
}

// =====================
// HEALTH
// =====================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    ai_configured: true,
    primary_provider: 'keylessai',
    fallback_1: 'agent-router',
    fallback_2: groqClient ? 'groq' : null,
    model: process.env.AI_MODEL || 'glm-5.3'
  });
});

// =====================
// TEST AI
// =====================
app.get('/api/test-ai', async (req, res) => {
  console.log('\n🧪 Testing AI with fallback chain...');
  const result = await callTextAI([
    { role: 'user', content: 'Reply with exactly: AI is working!' }
  ], { max_tokens: 50 });

  if (result.success) {
    res.json({
      success: true,
      provider: result.provider,
      response: result.content
    });
  } else {
    res.status(500).json({
      success: false,
      error: result.error,
      tried: ['keylessai', 'agent-router', groqClient ? 'groq' : null].filter(Boolean)
    });
  }
});

// =====================
// GENERATE BLUEPRINT (JSON)
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
    console.log('📐 Land:', normalizedData.landSize.width, 'x', normalizedData.landSize.depth);

    const prompt = buildBlueprintPrompt(normalizedData, country);

    const result = await callTextAI([
      {
        role: 'system',
        content: 'You are a professional architect. Return ONLY valid JSON. No markdown. Start with { and end with }.'
      },
      { role: 'user', content: prompt }
    ], { temperature: 0.2, max_tokens: 4000 });

    if (!result.success) {
      console.log('🔄 All text providers failed → template fallback');
      return res.json({
        success: true,
        data: generateTemplateBlueprint(normalizedData, country, customizations),
        source: 'template-fallback'
      });
    }

    console.log(`✅ AI content received from ${result.provider}. Length: ${result.content.length}`);

    let blueprint;
    try {
      let cleaned = result.content.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n/, '').replace(/\n```$/, '');
      }
      blueprint = JSON.parse(cleaned);
    } catch (e) {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        blueprint = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('AI returned no JSON');
      }
    }

    if (!blueprint.rooms || !Array.isArray(blueprint.rooms) || blueprint.rooms.length === 0) {
      console.log('⚠️ Missing rooms → template fallback');
      return res.json({
        success: true,
        data: generateTemplateBlueprint(normalizedData, country, customizations),
        source: 'template-fallback'
      });
    }

    // Ensure every bedroom has a bathroom
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

    console.log(`🎉 Blueprint generated via ${result.provider}: ${blueprint.rooms.length} rooms`);
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
      res.json({
        success: true,
        data: fallback,
        source: 'template-fallback'
      });
    } catch (fallbackError) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// =====================
// GENERATE BLUEPRINT IMAGE
// =====================
app.post('/api/generate-blueprint-image', async (req, res) => {
  try {
    const { buildingData, country } = req.body;
    const bedrooms = buildingData?.bedrooms || buildingData?.roomCount?.bedrooms || 3;

    console.log('\n🖼️ === AI IMAGE GENERATION REQUEST ===');
    console.log('🏠 Building:', buildingData?.buildingType);

    const prompt = buildImagePrompt(buildingData, country, bedrooms);

    let imageBase64 = null;
    let usedMethod = null;

    // Path 1: Responses API (15s timeout)
    try {
      console.log('🔧 Path 1: Responses API...');
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(`${process.env.AI_BASE_URL}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.AI_API_KEY}`,
          'User-Agent': process.env.AI_USER_AGENT || 'codex_cli_rs/0.101.0',
          'Originator': 'codex_cli_rs',
          'Version': '0.101.0'
        },
        body: JSON.stringify({
          model: process.env.AI_MODEL,
          input: prompt,
          tools: [{ type: 'image_generation' }]
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        const output = data.output || [];
        for (const item of output) {
          if (item.type === 'image_generation_call' && item.result) {
            imageBase64 = item.result;
            usedMethod = 'responses-api';
            console.log('✅ Image from Responses API');
            break;
          }
        }
      } else {
        console.log(`❌ Path 1 failed [${response.status}]`);
      }
    } catch (err) {
      console.log('❌ Path 1 error:', err.name === 'AbortError' ? 'Timeout' : err.message);
    }

    // Path 2: Cloudflare Workers AI (if configured)
    if (!imageBase64 && process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) {
      try {
        console.log('🔧 Path 2: Cloudflare Workers AI...');
        const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`;

        const response = await fetch(cfUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            prompt,
            num_steps: 4
          })
        });

        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          imageBase64 = Buffer.from(arrayBuffer).toString('base64');
          usedMethod = 'cloudflare-flux';
          console.log('✅ Image from Cloudflare FLUX');
        } else {
          console.log(`❌ Cloudflare failed [${response.status}]`);
        }
      } catch (err) {
        console.log('❌ Cloudflare error:', err.message);
      }
    }

    // Path 3: Pollinations.ai with retry
    if (!imageBase64) {
      console.log('🔧 Path 3: Pollinations.ai with retry...');
      const encodedPrompt = encodeURIComponent(prompt);
      const seed = Math.floor(Math.random() * 999999);
      const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true&model=flux&seed=${seed}`;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          console.log(`   Attempt ${attempt}/3...`);
          await new Promise(r => setTimeout(r, Math.random() * 2000));

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 45000);

          const response = await fetch(pollinationsUrl, {
            signal: controller.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; BlueprintGenerator/1.0)'
            }
          });
          clearTimeout(timeoutId);

          if (response.ok) {
            const buffer = await response.arrayBuffer();
            if (buffer.byteLength > 5000) {
              imageBase64 = Buffer.from(buffer).toString('base64');
              usedMethod = 'pollinations';
              console.log('✅ Image from Pollinations.ai');
              break;
            } else {
              console.log('   Response too small, retrying...');
            }
          } else if (response.status === 429) {
            console.log(`   429 rate limit — waiting...`);
            await new Promise(r => setTimeout(r, 3000 * attempt));
          } else {
            console.log(`   Failed [${response.status}]`);
          }
        } catch (err) {
          console.log(`   Attempt ${attempt} error:`, err.name === 'AbortError' ? 'Timeout' : err.message);
          if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      }
    }

    if (!imageBase64) {
      console.error('❌ All image paths failed');
      return res.status(500).json({
        success: false,
        error: 'Image generation unavailable. Please try again in a few minutes.',
        tried: ['responses-api', 'cloudflare-flux', 'pollinations']
      });
    }

    console.log(`🎉 Image generated via: ${usedMethod}`);
    res.json({
      success: true,
      imageBase64: `data:image/png;base64,${imageBase64}`,
      method: usedMethod
    });

  } catch (error) {
    console.error('❌ Image endpoint error:', error.message);
    res.status(500).json({ success: false, error: error.message });
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
  const guestToilet = buildingData?.guestToilet?.hasGuestToilet;
  const description = buildingData?.description || '';

  return `Professional architectural blueprint floor plan, top-down view, of a ${buildingType} with ${bedrooms} bedrooms on a ${landW} x ${landD} feet plot in ${country}. Classic blueprint style, deep blue background, white and cyan technical lines, room labels, dimension annotations, door swings, window symbols, title block, north arrow, scale bar. Include living room, kitchen, dining area, hallways, ${bedrooms} bedrooms each with attached bathroom${guestToilet ? ', guest toilet' : ''}. Engineering-quality technical drawing, no overlapping rooms.${description ? ` Client notes: ${description}` : ''}`;
}

// =====================
// TEMPLATE FALLBACK
// =====================
function generateTemplateBlueprint(data, country, customizations) {
  const bedrooms = data?.bedrooms || data?.roomCount?.bedrooms || 3;
  const landWidth = data?.landSize?.width || 50;
  const landDepth = data?.landSize?.depth || 60;
  const guestToilet = data?.guestToilet;
  const unit = country === 'US' || country === 'CA' ? 'feet' : 'meters';

  const rooms = [];
  let x = 10, y = 10;

  rooms.push({
    id: 'room-living', name: 'Living Room', type: 'living',
    width: 16, depth: 20, area: 320,
    position: { x, y }, color: '#3b82f6',
    doors: [{ wall: 'south', position: 0.5, width: 3 }],
    windows: [{ wall: 'north', position: 0.5, width: 6 }]
  });
  x += 21;

  rooms.push({
    id: 'room-kitchen', name: 'Kitchen', type: 'kitchen',
    width: 12, depth: 15, area: 180,
    position: { x, y }, color: '#f59e0b',
    doors: [{ wall: 'south', position: 0.5, width: 3 }],
    windows: [{ wall: 'north', position: 0.5, width: 4 }]
  });
  x += 17;

  rooms.push({
    id: 'room-dining', name: 'Dining Area', type: 'dining',
    width: 12, depth: 14, area: 168,
    position: { x, y }, color: '#ec4899',
    doors: [{ wall: 'south', position: 0.5, width: 3 }],
    windows: [{ wall: 'north', position: 0.5, width: 4 }]
  });

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

  if (guestToilet?.hasGuestToilet) {
    rooms.push({
      id: 'room-guest-toilet', name: 'Guest Toilet', type: 'bathroom',
      width: 5, depth: 7, area: 35,
      position: { x: 10, y: y + 20 }, color: '#06b6d4',
      doors: [{ wall: 'east', position: 0.5, width: 2.5 }],
      windows: []
    });
  }

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
// START SERVER
// =====================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/api/health`);
  console.log(`🧪 Test AI: http://localhost:${PORT}/api/test-ai\n`);
});
