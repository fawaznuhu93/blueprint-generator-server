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
// AI CLIENT
// =====================
const AI_MODEL = process.env.AI_MODEL || 'gpt-6-astra';

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

console.log('\n🤖 AI Configuration:');
console.log('   Model:', AI_MODEL);
console.log('   Base URL:', process.env.AI_BASE_URL);
console.log('   API Key:', process.env.AI_API_KEY ? `${process.env.AI_API_KEY.substring(0, 10)}...` : '❌ MISSING');
console.log('');

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
      console.error('⚠️ Content empty, stuck in reasoning. Reasoning length:', reasoning.length);
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
    ai_configured: !!process.env.AI_API_KEY,
    model: AI_MODEL,
    base_url: process.env.AI_BASE_URL
  });
});

// =====================
// TEST AI
// =====================
app.get('/api/test-ai', async (req, res) => {
  try {
    console.log('\n🧪 Testing AI connection...');
    const response = await aiClient.chat.completions.create({
      model: AI_MODEL,
      messages: [{ role: 'user', content: 'Reply with exactly: AI is working!' }],
      max_tokens: 200
    });
    const content = extractAIContent(response);
    if (!content) return res.status(500).json({ success: false, error: 'AI returned no usable content' });
    console.log('✅ AI Test Success:', content);
    res.json({ success: true, model_used: AI_MODEL, response: content });
  } catch (error) {
    console.error('❌ AI Test Failed:', error.message);
    res.status(500).json({ success: false, error: error.message, status: error.status });
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
    console.log('📡 Model:', AI_MODEL);

    const prompt = buildBlueprintPrompt(normalizedData, country);
    const startTime = Date.now();

    const response = await aiClient.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: 'You are a professional architect. Return ONLY valid JSON. No markdown. Start with { and end with }.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 4000
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`⏱️  AI call took ${elapsed}s`);

    const blueprintText = extractAIContent(response);

    if (!blueprintText) {
      console.log('🔄 AI gave no content → template fallback');
      return res.json({
        success: true,
        data: generateTemplateBlueprint(normalizedData, country, customizations),
        source: 'template-fallback',
        aiError: 'AI returned empty content'
      });
    }

    console.log(`✅ AI content received. Length: ${blueprintText.length}`);

    let blueprint;
    try {
      let cleaned = blueprintText.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n/, '').replace(/\n```$/, '');
      }
      blueprint = JSON.parse(cleaned);
    } catch (e) {
      const jsonMatch = blueprintText.match(/\{[\s\S]*\}/);
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

    console.log(`🎉 Blueprint generated by AI: ${blueprint.rooms.length} rooms`);
    res.json({ success: true, data: blueprint, source: 'ai', model: AI_MODEL });

  } catch (error) {
    console.error('❌ Generation error:', error.message);
    try {
      const fallback = generateTemplateBlueprint(req.body.buildingData, req.body.country, req.body.customizations);
      res.json({ success: true, data: fallback, source: 'template-fallback', aiError: error.message });
    } catch (fallbackError) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// =====================
// GENERATE BLUEPRINT IMAGE
// Path 1: Responses API (30s timeout)
// Path 2: Chat image modality
// Path 3: DALL-E 3 (Images API)
// Path 4: Pollinations.ai (FREE fallback)
// =====================
app.post('/api/generate-blueprint-image', async (req, res) => {
  try {
    const { buildingData, country } = req.body;
    const bedrooms = buildingData?.bedrooms || buildingData?.roomCount?.bedrooms || 3;

    console.log('\n🖼️ === AI IMAGE GENERATION REQUEST ===');
    console.log('🏠 Building:', buildingData?.buildingType);

    const prompt = buildImagePrompt(buildingData, country, bedrooms);

    let imageBase64 = null;
    let imageUrl = null;
    let usedMethod = null;

    // ==========================================
    // PATH 1: Responses API (with 30s timeout)
    // ==========================================
    try {
      console.log('🔧 Path 1: Responses API...');
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

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
          model: AI_MODEL,
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
        if (!imageBase64) console.log('❌ Path 1: No image in response');
      } else {
        console.log(`❌ Path 1 failed [${response.status}]`);
      }
    } catch (err) {
      console.log('❌ Path 1 error:', err.name === 'AbortError' ? 'Timeout' : err.message);
    }

    // ==========================================
    // PATH 2: Chat image modality
    // ==========================================
    if (!imageBase64) {
      try {
        console.log('🔧 Path 2: Chat image modality...');
        const response = await aiClient.chat.completions.create({
          model: AI_MODEL,
          messages: [{ role: 'user', content: prompt }],
          // @ts-ignore
          modalities: ['text', 'image'],
          max_tokens: 2000
        });

        const message = response.choices?.[0]?.message;
        if (message?.images?.length > 0) {
          const img = message.images[0];
          imageBase64 = img?.image_url?.url?.replace(/^data:image\/\w+;base64,/, '') || img?.b64_json;
          if (imageBase64) {
            usedMethod = 'chat-image-modality';
            console.log('✅ Image from Chat API');
          }
        } else {
          console.log('❌ Path 2: No images');
        }
      } catch (err) {
        console.log('❌ Path 2 error:', err.message);
      }
    }

    // ==========================================
    // PATH 3: DALL-E 3
    // ==========================================
    if (!imageBase64) {
      try {
        console.log('🔧 Path 3: DALL-E 3...');
        const response = await fetch(`${process.env.AI_BASE_URL}/images/generations`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.AI_API_KEY}`,
            'User-Agent': process.env.AI_USER_AGENT || 'codex_cli_rs/0.101.0',
            'Originator': 'codex_cli_rs',
            'Version': '0.101.0'
          },
          body: JSON.stringify({
            model: 'dall-e-3',
            prompt,
            n: 1,
            size: '1024x1024',
            response_format: 'b64_json'
          })
        });

        if (response.ok) {
          const data = await response.json();
          imageBase64 = data.data?.[0]?.b64_json;
          if (imageBase64) {
            usedMethod = 'dall-e-3';
            console.log('✅ Image from DALL-E 3');
          }
        } else {
          console.log(`❌ Path 3 failed [${response.status}]`);
        }
      } catch (err) {
        console.log('❌ Path 3 error:', err.message);
      }
    }

    // ==========================================
    // PATH 4: Pollinations.ai (FREE fallback)
    // ==========================================
    if (!imageBase64 && !imageUrl) {
      try {
        console.log('🔧 Path 4: Pollinations.ai (free fallback)...');
        const encodedPrompt = encodeURIComponent(prompt);
        const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true&model=flux&seed=${Date.now()}`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        const response = await fetch(pollinationsUrl, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (response.ok) {
          const buffer = await response.arrayBuffer();
          imageBase64 = Buffer.from(buffer).toString('base64');
          usedMethod = 'pollinations';
          console.log('✅ Image from Pollinations.ai (free)');
        } else {
          console.log(`❌ Path 4 failed [${response.status}]`);
        }
      } catch (err) {
        console.log('❌ Path 4 error:', err.name === 'AbortError' ? 'Timeout' : err.message);
      }
    }

    // ======================
    // RESULT
    // ======================
    if (!imageBase64) {
      console.error('❌ All image paths failed');
      return res.status(500).json({
        success: false,
        error: 'Image generation unavailable on all paths',
        tried: ['responses-api', 'chat-image-modality', 'dall-e-3', 'pollinations']
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

  return `Professional architectural blueprint floor plan, top-down view, of a ${buildingType} with ${bedrooms} bedrooms on a ${landW} x ${landD} feet plot in ${country}.

STYLE:
- Classic blueprint aesthetic: deep blue background #1a3a5c
- White and cyan technical line work
- Visible grid lines
- Room labels in uppercase
- Dimension annotations
- Door swing arcs
- Window symbols on exterior walls
- Title block bottom-left
- North arrow top-right
- Scale bar bottom-right

CONTENT:
- Living room, kitchen, dining area, hallways
- ${bedrooms} bedrooms, EACH with attached bathroom
- ${guestToilet ? 'Guest toilet included' : 'No guest toilet'}
- Clean professional layout, no overlapping rooms
- Engineering-quality technical drawing

${description ? `Client notes: ${description}` : ''}`;
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

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/api/health`);
  console.log(`🧪 Test AI: http://localhost:${PORT}/api/test-ai\n`);
});