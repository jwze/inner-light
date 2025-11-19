// 全局变量
let wordFrequency = {}; // 存储文字及其频率
let wordElements = []; // 存储文字DOM元素和3D位置
let scene, camera, renderer;
let radius = 300; // 球体半径
let autoRotateSpeed = 0.002; // 自动旋转速度
let mouseX = 0, mouseY = 0;
let targetRotationX = 0, targetRotationY = 0;
let currentRotationX = 0, currentRotationY = 0;

// 初始化
function init() {
    setupScene();
    setupEventListeners();
    addSampleWords(); // 添加一些示例文字
    animate();
}

// 设置Three.js场景
function setupScene() {
    const container = document.getElementById('canvas-container');

    // 创建场景
    scene = new THREE.Scene();

    // 创建相机
    camera = new THREE.PerspectiveCamera(
        75,
        window.innerWidth / window.innerHeight,
        0.1,
        2000
    );
    camera.position.z = 600;

    // 创建渲染器（用于计算3D位置，不实际渲染）
    renderer = new THREE.WebGLRenderer({ alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.domElement.style.display = 'none'; // 隐藏canvas
    container.appendChild(renderer.domElement);
}

// 设置事件监听
function setupEventListeners() {
    const addBtn = document.getElementById('addBtn');
    const wordInput = document.getElementById('wordInput');

    // 添加按钮点击事件
    addBtn.addEventListener('click', addWord);

    // 回车键添加文字
    wordInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            addWord();
        }
    });

    // 鼠标移动事件 - 影响旋转
    document.addEventListener('mousemove', (e) => {
        mouseX = (e.clientX - window.innerWidth / 2) / (window.innerWidth / 2);
        mouseY = (e.clientY - window.innerHeight / 2) / (window.innerHeight / 2);
        targetRotationX = mouseY * 0.3;
        targetRotationY = mouseX * 0.3;
    });

    // 窗口大小改变
    window.addEventListener('resize', onWindowResize);
}

// 添加文字
function addWord() {
    const input = document.getElementById('wordInput');
    const word = input.value.trim();

    if (!word) return;

    // 更新频率
    let isNewWord = false;

    if (wordFrequency[word]) {
        wordFrequency[word]++;
        updateWordSize(word);
    } else {
        wordFrequency[word] = 1;
        createWordElement(word);
        isNewWord = true;
    }

    if (isNewWord) {
        redistributeWords(); // 新增单词后重新分布，避免扎堆
    }

    // 更新统计
    updateStats();

    // 清空输入框
    input.value = '';
    input.focus();
}

// 创建文字元素
function createWordElement(word) {
    const container = document.getElementById('canvas-container');

    // 创建文字DOM元素
    const wordEl = document.createElement('div');
    wordEl.className = 'word-tag';
    wordEl.textContent = word;
    wordEl.dataset.word = word;

    container.appendChild(wordEl);

    // 存储文字元素和位置信息
    wordElements.push({
        element: wordEl,
        word: word,
        position: { x: 0, y: 0, z: 0 },
        vector: new THREE.Vector3(0, 0, 0),
        baseHue: getEarthHue(wordElements.length)
    });

    // 设置初始大小
    updateWordSize(word);
}

// 获取球面上的均匀分布位置（Fibonacci Sphere）
function getSpherePosition(index, total) {
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const t = (index + 0.5) / total; // 避免极点重叠
    const inclination = Math.acos(1 - 2 * t);
    const azimuth = goldenAngle * index;

    return {
        x: radius * Math.sin(inclination) * Math.cos(azimuth),
        y: radius * Math.sin(inclination) * Math.sin(azimuth),
        z: radius * Math.cos(inclination)
    };
}

// 更新文字大小（根据频率）
function updateWordSize(word) {
    const frequency = wordFrequency[word];
    const wordObj = wordElements.find(w => w.word === word);

    if (!wordObj) return;

    // 基础大小12px，每增加一次频率增加3px，最大40px
    const minSize = 12;
    const maxSize = 40;
    const sizeIncrement = 3;
    const size = Math.min(minSize + (frequency - 1) * sizeIncrement, maxSize);

    wordObj.element.style.fontSize = size + 'px';

}

// 更新所有文字位置（重新分布）
function redistributeWords() {
    const total = wordElements.length || 1;

    wordElements.forEach((wordObj, index) => {
        const position = getSpherePosition(index, total);
        wordObj.position = position;
        wordObj.vector.set(position.x, position.y, position.z);
    });
}

// 更新统计信息
function updateStats() {
    const totalWords = Object.keys(wordFrequency).length;
    document.getElementById('wordCount').textContent = totalWords;
}

// 动画循环
function animate() {
    requestAnimationFrame(animate);

    // 平滑旋转
    currentRotationX += (targetRotationX - currentRotationX) * 0.05;
    currentRotationY += (targetRotationY - currentRotationY) * 0.05;

    // 自动旋转
    currentRotationY += autoRotateSpeed;

    // 更新所有文字位置
    updateWordPositions();
}

// 更新文字位置
function updateWordPositions() {
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    const perspective = 800; // 控制近大远小的透视深度

    wordElements.forEach(wordObj => {
        // 创建旋转矩阵
        const rotatedVector = wordObj.vector.clone();
        const frequency = wordFrequency[wordObj.word] || 1;

        // 应用Y轴旋转
        rotatedVector.applyAxisAngle(new THREE.Vector3(0, 1, 0), currentRotationY);

        // 应用X轴旋转
        rotatedVector.applyAxisAngle(new THREE.Vector3(1, 0, 0), currentRotationX);

        // 投影到2D屏幕
        const scale = perspective / (perspective - rotatedVector.z);
        const x = rotatedVector.x * scale + centerX;
        const y = rotatedVector.y * scale + centerY;

        // 更新DOM位置
        wordObj.element.style.left = x + 'px';
        wordObj.element.style.top = y + 'px';

        // 根据z轴位置调整透明度和大小（近大远小）
        const depthScale = Math.max(0.4, Math.min(1.3, scale));
        const brightness = Math.max(0.6, Math.min(1.4, 0.7 + depthScale * 0.5));
        const frequencyBoost = Math.min(0.35, (frequency - 1) * 0.04);

        wordObj.element.style.opacity = Math.max(0.35, Math.min(1, depthScale + frequencyBoost));
        wordObj.element.style.transform = `translate(-50%, -50%) scale(${depthScale})`;
        wordObj.element.style.filter = `brightness(${brightness}) drop-shadow(0 0 8px rgba(120, 190, 255, ${0.2 + depthScale * 0.2}))`;
        wordObj.element.style.color = `hsl(${wordObj.baseHue}, 70%, ${50 + depthScale * 15}%)`;

        // z-index: 前面的文字在上层
        wordObj.element.style.zIndex = Math.floor(rotatedVector.z + 1000);
    });
}

// 窗口大小改变处理
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// 添加示例文字
function addSampleWords() {
    const sampleWords = [
        '梦想', '希望', '勇气', '爱', '自由',
        '快乐', '和平', '友谊', '美好', '未来',
        '创造', '探索', '成长', '坚持', '信念',
        '智慧', '力量', '光明', '真理', '正义',
        '善良', '美丽', '成功', '幸福', '和谐',
        '创新', '进步', '奋斗', '拼搏', '超越',
        '感恩', '宽容', '理解', '尊重', '信任',
        '责任', '使命', '价值', '意义', '目标',
        '理想', '激情', '热情', '专注', '专业',
        '卓越', '完美', '精致', '细腻', '优雅'
    ];

    sampleWords.forEach(word => {
        wordFrequency[word] = 1;
        createWordElement(word);
    });

    // 模拟一些高频词
    wordFrequency['梦想'] = 8;
    updateWordSize('梦想');

    wordFrequency['希望'] = 6;
    updateWordSize('希望');

    wordFrequency['爱'] = 7;
    updateWordSize('爱');

    wordFrequency['勇气'] = 5;
    updateWordSize('勇气');

    wordFrequency['自由'] = 4;
    updateWordSize('自由');

    wordFrequency['快乐'] = 5;
    updateWordSize('快乐');

    wordFrequency['成长'] = 4;
    updateWordSize('成长');

    wordFrequency['成功'] = 6;
    updateWordSize('成功');

    wordFrequency['幸福'] = 5;
    updateWordSize('幸福');

    redistributeWords(); // 初始样例填充后统一分布
    updateStats();
}

// 为地球配色生成基础色相（蓝绿之间）
function getEarthHue(seed) {
    const hues = [190, 200, 210, 160]; // 海洋+陆地色相
    return hues[seed % hues.length];
}

// 页面加载完成后初始化
window.addEventListener('DOMContentLoaded', init);
