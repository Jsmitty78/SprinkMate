#!/usr/bin/env python3
"""Regenerate the small Xcode project without third-party build tooling."""
from pathlib import Path
import hashlib

root = Path(__file__).resolve().parent.parent
project = root / 'FieldAgent.xcodeproj'
project.mkdir(exist_ok=True)
objects = []
def ident(name):
    return hashlib.sha1(name.encode()).hexdigest()[:24].upper()
def obj(name, body):
    objects.append(f'{ident(name)} = {{ {body} }};')
    return ident(name)
def refs(names):
    return '(' + ', '.join(ident(name) for name in names) + ',)'

sources = sorted(path.name for path in (root / 'FieldAgent').glob('*.swift'))
test_sources = sorted(path.name for path in (root / 'FieldAgentTests').glob('*.swift'))
for filename in sources:
    obj(filename, f'isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = {filename}; sourceTree = "<group>";')
    obj('build-'+filename, f'isa = PBXBuildFile; fileRef = {ident(filename)};')
obj('Info.plist', 'isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>";')
for filename in test_sources:
    obj(filename, f'isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = {filename}; sourceTree = "<group>";')
    obj('build-'+filename, f'isa = PBXBuildFile; fileRef = {ident(filename)};')
obj('app-product', 'isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = FieldAgent.app; sourceTree = BUILT_PRODUCTS_DIR;')
obj('test-product', 'isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = FieldAgentTests.xctest; sourceTree = BUILT_PRODUCTS_DIR;')
obj('app-group', f'isa = PBXGroup; children = {refs(sources+["Info.plist"])}; path = FieldAgent; sourceTree = "<group>";')
obj('test-group', f'isa = PBXGroup; children = {refs(test_sources)}; path = FieldAgentTests; sourceTree = "<group>";')
obj('products', f'isa = PBXGroup; children = {refs(["app-product", "test-product"])}; name = Products; sourceTree = "<group>";')
obj('main-group', f'isa = PBXGroup; children = {refs(["app-group", "test-group", "products"])}; sourceTree = "<group>";')
obj('focus-package', 'isa = XCRemoteSwiftPackageReference; repositoryURL = "https://github.com/maxxfrazer/FocusEntity.git"; requirement = {kind = revision; revision = 3e08b26f863957113f4d0b2d45cf6dfbd1a41333;};')
obj('focus-product', f'isa = XCSwiftPackageProductDependency; package = {ident("focus-package")}; productName = FocusEntity;')
obj('build-focus', f'isa = PBXBuildFile; productRef = {ident("focus-product")};')
obj('app-sources', f'isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = {refs(["build-"+f for f in sources])}; runOnlyForDeploymentPostprocessing = 0;')
obj('app-frameworks', f'isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = {refs(["build-focus"])}; runOnlyForDeploymentPostprocessing = 0;')
obj('app-resources', 'isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;')
obj('test-sources', f'isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = {refs(["build-"+f for f in test_sources])}; runOnlyForDeploymentPostprocessing = 0;')
obj('test-frameworks', 'isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;')
obj('test-dependency', f'isa = PBXTargetDependency; target = {ident("app-target")}; targetProxy = {ident("test-proxy")};')
obj('test-proxy', f'isa = PBXContainerItemProxy; containerPortal = {ident("project")}; proxyType = 1; remoteGlobalIDString = {ident("app-target")}; remoteInfo = FieldAgent;')
for scope in ['project', 'app', 'test']:
    for config in ['Debug', 'Release']:
        settings = {
            'project': 'CLANG_ENABLE_MODULES = YES; CLANG_ENABLE_OBJC_ARC = YES; SDKROOT = iphoneos; IPHONEOS_DEPLOYMENT_TARGET = 18.0; SWIFT_VERSION = 5.0; ENABLE_USER_SCRIPT_SANDBOXING = YES;',
            'app': 'PRODUCT_NAME = "$(TARGET_NAME)"; PRODUCT_BUNDLE_IDENTIFIER = dev.innovationcup.FieldAgent; INFOPLIST_FILE = FieldAgent/Info.plist; GENERATE_INFOPLIST_FILE = NO; TARGETED_DEVICE_FAMILY = 1; SUPPORTED_PLATFORMS = "iphoneos iphonesimulator"; SUPPORTS_MACCATALYST = NO; CODE_SIGN_STYLE = Automatic; SWIFT_EMIT_LOC_STRINGS = YES; LD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks";',
            'test': 'PRODUCT_NAME = "$(TARGET_NAME)"; PRODUCT_BUNDLE_IDENTIFIER = dev.innovationcup.FieldAgentTests; GENERATE_INFOPLIST_FILE = YES; TARGETED_DEVICE_FAMILY = 1; SUPPORTED_PLATFORMS = "iphoneos iphonesimulator"; CODE_SIGN_STYLE = Automatic; BUNDLE_LOADER = "$(TEST_HOST)"; TEST_HOST = "$(BUILT_PRODUCTS_DIR)/FieldAgent.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/FieldAgent"; LD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks @loader_path/Frameworks";',
        }[scope]
        if scope == 'project':
            settings += ' DEBUG_INFORMATION_FORMAT = dwarf; SWIFT_OPTIMIZATION_LEVEL = "-Onone"; ENABLE_TESTABILITY = YES; SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG; ONLY_ACTIVE_ARCH = YES;' if config == 'Debug' else ' DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym"; SWIFT_COMPILATION_MODE = wholemodule; VALIDATE_PRODUCT = YES;'
        obj(f'{scope}-{config}', f'isa = XCBuildConfiguration; buildSettings = {{{settings}}}; name = {config};')
    obj(scope+'-configs', f'isa = XCConfigurationList; buildConfigurations = {refs([scope+"-Debug",scope+"-Release"])}; defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;')
obj('app-target', f'isa = PBXNativeTarget; buildConfigurationList = {ident("app-configs")}; buildPhases = {refs(["app-sources", "app-frameworks", "app-resources"])}; buildRules = (); dependencies = (); name = FieldAgent; packageProductDependencies = {refs(["focus-product"])}; productName = FieldAgent; productReference = {ident("app-product")}; productType = "com.apple.product-type.application";')
obj('test-target', f'isa = PBXNativeTarget; buildConfigurationList = {ident("test-configs")}; buildPhases = {refs(["test-sources", "test-frameworks"])}; buildRules = (); dependencies = {refs(["test-dependency"])}; name = FieldAgentTests; productName = FieldAgentTests; productReference = {ident("test-product")}; productType = "com.apple.product-type.bundle.unit-test";')
obj('project', f'isa = PBXProject; attributes = {{BuildIndependentTargetsInParallel = YES; LastSwiftUpdateCheck = 2600; LastUpgradeCheck = 2600; TargetAttributes = {{{ident("app-target")} = {{CreatedOnToolsVersion = 26.6;}}; {ident("test-target")} = {{CreatedOnToolsVersion = 26.6; TestTargetID = {ident("app-target")};}};}};}}; buildConfigurationList = {ident("project-configs")}; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en, Base, ja); mainGroup = {ident("main-group")}; packageReferences = {refs(["focus-package"])}; productRefGroup = {ident("products")}; projectDirPath = ""; projectRoot = ""; targets = {refs(["app-target", "test-target"])};')
(project / 'project.pbxproj').write_text('// !$*UTF8*$!\n{archiveVersion = 1; classes = {}; objectVersion = 56; objects = {\n' + '\n'.join(objects) + f'\n}}; rootObject = {ident("project")};\n}}\n')
scheme_dir = project / 'xcshareddata' / 'xcschemes'
scheme_dir.mkdir(parents=True, exist_ok=True)
def buildable(name, product):
    return f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{ident(name)}" BuildableName="{product}" BlueprintName="{product.split(".")[0]}" ReferencedContainer="container:FieldAgent.xcodeproj"/>'
app = buildable('app-target', 'FieldAgent.app')
test = buildable('test-target', 'FieldAgentTests.xctest')
(scheme_dir/'FieldAgent.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2600" version="1.3">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{app}</BuildActionEntry><BuildActionEntry buildForTesting="YES" buildForRunning="NO" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="NO">{test}</BuildActionEntry></BuildActionEntries></BuildAction>
<TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">{test}</TestableReference></Testables></TestAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{app}</BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugServiceExtension="internal"><BuildableProductRunnable runnableDebuggingMode="0">{app}</BuildableProductRunnable></ProfileAction>
<AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>''')
print(project)
