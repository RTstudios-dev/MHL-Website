(() => {
  const euroFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const compactEuroFormat = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'EUR',
    notation: 'compact',
    maximumFractionDigits: 1,
  });

  const ensureConfig = signup => {
    const config = signup.bannerConfig && typeof signup.bannerConfig === 'object'
      ? signup.bannerConfig : {};
    if (!Array.isArray(config.equippedStats))
      config.equippedStats = ['Goals', 'Assists', 'Saves'];
    else config.equippedStats = [...new Set(config.equippedStats)].slice(0, 3);
    if (typeof config.poseId !== 'string')
      config.poseId = signup.bannerDefaults && typeof signup.bannerDefaults.poseId === 'string'
        ? signup.bannerDefaults.poseId : '';
    signup.bannerConfig = config;
    return config;
  };

  const formatValue = raw => {
    const value = Number(raw) || 0;
    if (!value) return '—';
    return value >= 1_000_000
      ? compactEuroFormat.format(value).replace(/([KMBT])$/, (_, suffix) => suffix.toLowerCase())
      : euroFormat.format(value);
  };

  const fit = (viewport, canvas) => {
    const width = viewport.clientWidth || 590;
    canvas.style.transform = `scale(${width / 849})`;
  };

  const render = (viewport, canvas, signup, options = {}) => {
    canvas.replaceChildren();
    if (!signup) return;

    const config = ensureConfig(signup);
    const defaults = signup.bannerDefaults || {};
    const activePoseId = config.poseId || defaults.poseId || '';
    const badgeFrameSize = 500;
    const badgeImageSize = 400;
    const badgeScaleRatio = 184 / badgeImageSize;
    const targeting = ['badges', 'stats'].includes(options.targeting) ? options.targeting : '';
    const onTarget = typeof options.onTarget === 'function' ? options.onTarget : () => {};
    const clampScale = value => Math.max(0.1, Math.min(5, Number(value) || 1));
    const transformAt = (values, index, fallback, minScale = 0.1) => {
      const transform = Array.isArray(values) && values[index] && typeof values[index] === 'object'
        ? values[index] : fallback;
      return {
        x: Number.isFinite(Number(transform.x)) ? Number(transform.x) : fallback.x,
        y: Number.isFinite(Number(transform.y)) ? Number(transform.y) : fallback.y,
        scale: Math.max(minScale, Math.min(5, Number(transform.scale) || 1)),
      };
    };
    const makeTarget = (element, category, target) => {
      if (targeting !== category) return;
      element.classList.add('player-banner-target');
      element.setAttribute('role', 'button');
      element.setAttribute('tabindex', '0');
      element.setAttribute('aria-label', category === 'badges'
        ? `Badge slot ${target.slot + 1}`
        : `Stat position ${target.slot + 1}`);
      element.removeAttribute('aria-hidden');
      const select = event => {
        event.preventDefault();
        event.stopPropagation();
        onTarget(target);
      };
      const baseTransform = element.style.transform;
      const scaleOnHover = () => {
        if (baseTransform) element.style.transform = `${baseTransform} scale(1.055)`;
      };
      const resetHoverScale = () => {
        if (baseTransform) element.style.transform = baseTransform;
      };
      element.addEventListener('click', select);
      element.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') select(event);
      });
      element.addEventListener('pointerenter', scaleOnHover);
      element.addEventListener('pointerleave', resetHoverScale);
      element.addEventListener('focus', scaleOnHover);
      element.addEventListener('blur', resetHoverScale);
    };
    const applyPosition = (element, transform) => {
      element.style.left = `${transform.x}px`;
      element.style.top = `${transform.y}px`;
      element.style.transform = `scale(${transform.scale})`;
      element.style.transformOrigin = 'top left';
    };
    const addImage = (item, key, zIndex, category = '') => {
      if (!item || !item.image) return;
      const transform = item.transform && typeof item.transform === 'object'
        ? item.transform : {};
      const scale = clampScale(transform.scale);
      const image = document.createElement('img');
      image.className = 'player-banner-image';
      image.src = item.image;
      image.alt = '';
      image.setAttribute('aria-hidden', 'true');
      image.dataset.layerKey = key;
      image.style.zIndex = String(zIndex);
      image.style.left = `${Number(transform.x) || 0}px`;
      image.style.top = `${Number(transform.y) || 0}px`;
      const setDimensions = () => {
        image.style.width = `${(Number(item.naturalWidth) || image.naturalWidth || 260) * scale}px`;
        image.style.height = `${(Number(item.naturalHeight) || image.naturalHeight || 260) * scale}px`;
      };
      image.addEventListener('load', setDimensions);
      setDimensions();
      if (category) {
        image.dataset.spriteCategory = category;
        makeTarget(image, category, { category, itemId: item.id });
      }
      canvas.append(image);
    };

    const collections = {
      background: { items: signup.backgroundSprites || [], configKey: 'backgroundSpriteId' },
      helmet: { items: signup.helmetSprites || [], configKey: 'helmetSpriteId' },
      torso: { items: signup.torsoSprites || [], configKey: 'torsoSpriteId' },
      stick: { items: signup.stickSprites || [], configKey: 'stickSpriteId' },
      puck: { items: signup.puckSprites || [], configKey: 'puckSpriteId' },
    };
    if (activePoseId) {
      Object.values(collections).forEach(collection => {
        collection.items = collection.items.filter(item => item.poseId === activePoseId);
      });
    }
    const customLayers = Array.isArray(signup.bannerLayers) ? signup.bannerLayers : [];
    const defaultOrder = ['badges', 'stick', 'torso', 'puck', 'helmet', 'background'];
    const validKeys = new Set([...Object.keys(collections), 'badges', ...customLayers.map(layer => `custom:${layer.id}`)]);
    const layerOrder = Array.isArray(defaults.layerOrder)
      ? defaults.layerOrder.filter((key, index, order) => validKeys.has(key) && order.indexOf(key) === index)
      : [];
    defaultOrder.forEach(key => { if (!layerOrder.includes(key)) layerOrder.push(key); });
    customLayers.forEach(layer => {
      const key = `custom:${layer.id}`;
      if (!layerOrder.includes(key)) layerOrder.unshift(key);
    });
    layerOrder.forEach((key, index) => {
      const zIndex = 10 + layerOrder.length - index;
      if (key.startsWith('custom:')) {
        const layer = customLayers.find(item => item.id === key.slice(7));
        addImage(layer, key, zIndex);
        return;
      }
      const collection = collections[key];
      if (!collection) return;
      const items = collection.items;
      const selectedId = config[collection.configKey];
      const item = items.find(entry => entry.id === selectedId && entry.image)
        || items.find(entry => entry.id === defaults[key] && entry.image)
        || items.find(entry => entry.image);
      addImage(item, `sprite:${item && item.id || key}`, zIndex,
        ['helmet', 'torso', 'stick', 'puck'].includes(key) ? key : '');
    });

    const badges = Array.isArray(signup.badges) ? signup.badges : [];
    const badgeSlots = Array.isArray(signup.badgeSlots) ? signup.badgeSlots : [];
    const defaultBadge = badges.find(item => item.id === defaults.badge && item.image);
    for (let index = 0; index < 3; index++) {
      const equipped = badges.find(item => item.id === badgeSlots[index] && item.unlocked && item.image);
      const badge = equipped || (index === 0 ? defaultBadge : null);
      let transform = transformAt(defaults.badgeTransforms, index,
        { x: [50, 332, 614][index], y: 180, scale: 1 }, 0.02);
      if ((Number(defaults.canvasVersion) || 0) < 6) {
        const migratedScale = transform.scale * badgeScaleRatio;
        const inset = (badgeFrameSize - badgeImageSize) * migratedScale / 2;
        transform = {
          x: transform.x - inset,
          y: transform.y - inset,
          scale: migratedScale,
        };
      }
      const badgeScale = badge
        ? badgeScaleRatio * clampScale((Number(badge.scale) || 1) * (transform.scale / badgeScaleRatio))
        : 0;
      if (badge) {
        const image = document.createElement('img');
        image.className = 'player-banner-image';
        image.src = badge.image;
        image.alt = '';
        image.setAttribute('aria-hidden', 'true');
        image.dataset.layerKey = `badge-slot:${index}`;
        image.style.zIndex = '200';
        const frameSize = badgeFrameSize * transform.scale;
        const imageSize = badgeImageSize * badgeScale;
        image.style.left = `${transform.x + (frameSize - imageSize) / 2}px`;
        image.style.top = `${transform.y + (frameSize - imageSize) / 2}px`;
        image.style.width = `${imageSize}px`;
        image.style.height = `${imageSize}px`;
        canvas.append(image);
      }
      if (targeting === 'badges') {
        const target = document.createElement('button');
        target.type = 'button';
        target.className = 'player-banner-badge-target';
        target.setAttribute('aria-label', `Badge slot ${index + 1}`);
        target.style.zIndex = '201';
        target.style.left = `${transform.x}px`;
        target.style.top = `${transform.y}px`;
        target.style.width = `${badgeFrameSize * transform.scale}px`;
        target.style.height = `${badgeFrameSize * transform.scale}px`;
        makeTarget(target, 'badges', { category: 'badges', slot: index });
        canvas.append(target);
      }
    }

    const addText = (text, className, transform, zIndex, target = null) => {
      if (!text) return;
      const element = document.createElement('div');
      element.className = `player-banner-text ${className}`;
      element.textContent = text;
      element.style.zIndex = String(zIndex);
      if (className === 'player-banner-name') {
        element.style.left = `${transform.x}px`;
        element.style.top = `${transform.y}px`;
        element.style.transform = `translateX(-50%) scale(${transform.scale})`;
        element.style.transformOrigin = 'top center';
      } else {
        applyPosition(element, transform);
      }
      if (target) makeTarget(element, target.category, target);
      canvas.append(element);
    };
    const addRankedText = (text, rank, className, transform, zIndex, target = null) => {
      if (!text) return;
      if (rank >= 1 && rank <= 3) {
        const rankNames = { 1: '1st', 2: '2nd', 3: '3rd' };
        const rankClasses = { 1: 'gold', 2: 'silver', 3: 'bronze' };
        const rankElement = document.createElement('div');
        rankElement.className = `player-banner-stat-rank player-banner-stat-rank-${rankClasses[rank]}`;
        rankElement.textContent = rankNames[rank];
        rankElement.style.zIndex = String(zIndex + 1);
        rankElement.style.left = `${transform.x - 70}px`;
        rankElement.style.top = `${transform.y}px`;
        rankElement.style.transform = `scale(${transform.scale})`;
        rankElement.style.transformOrigin = 'top left';
        canvas.append(rankElement);
      }
      addText(text, className, transform, zIndex, target);
    };
    const playerNameTransform = transformAt(
      [defaults.playerNameTransform], 0, { x: 424.5, y: 45, scale: 1 });
    if ((Number(defaults.canvasVersion) || 0) < 5) playerNameTransform.x = 424.5;
    addText(signup.name || 'Player', 'player-banner-name', playerNameTransform, 100);
    addText(formatValue(signup.value), 'player-banner-value',
      transformAt([defaults.playerValueTransform], 0, { x: 50, y: 120, scale: 1 }), 100);

    const stats = signup.trackedStats || {};
    const statValue = stat => {
      const values = {
        Goals: stats.goals, Assists: stats.assists, Saves: stats.saves,
        Wins: stats.wins, Losses: stats.losses, 'Stick Saves': stats.stickSaves,
        'Body Saves': stats.bodySaves, Passes: stats.passes, 'Games Played': stats.gamesPlayed,
        'Games Scored In': stats.gamesScoredIn, '3-Goal Games': stats.gamesWith3Goals,
        '5-Goal Games': stats.gamesWith5Goals, '10-Goal Games': stats.gamesWith10Goals,
        '100% Save Percentage Games': stats.gamesWith100PercentSavePercentage,
        '10-Save Games': stats.gamesWith10Saves, '20-Save Games': stats.gamesWith20Saves,
        '30-Save Games': stats.gamesWith30Saves,
      };
      if (Object.prototype.hasOwnProperty.call(values, stat)) return String(Number(values[stat]) || 0);
      if (stat === 'Skater Value' || stat === 'Goalie Value') {
        const amount = Number(stat === 'Goalie Value' ? signup.goalieValue : signup.skaterValue) || 0;
        return String(amount);
      }
      if (stat === 'Save Percentage') {
        const games = Number(stats.savePercentageGames) || 0;
        const basis = Number(stats.savePercentageTotalBasisPoints) || 0;
        return games ? (basis / games / 100).toFixed(1) : '0.0';
      }
      return '0';
    };
    config.equippedStats.slice(0, 3).forEach((stat, index) => {
      const labelTransform = transformAt(defaults.statTransforms, index, { x: 50, y: [760, 900, 1040][index], scale: 1 });
      const valueTransform = transformAt(defaults.statValueTransforms, index, { x: 50, y: [803, 943, 1083][index], scale: 1 });
      const target = targeting === 'stats' ? { category: 'stats', slot: index } : null;
      addText(stat, 'player-banner-stat-label', labelTransform, 300, target);
      const rank = Number(signup.statRanks && signup.statRanks[stat]) || 0;
      addRankedText(statValue(stat), rank, 'player-banner-stat-value', valueTransform, 301, target);
    });
    fit(viewport, canvas);
  };

  window.MHLPlayerBanner = { ensureConfig, fit, render };
})();
