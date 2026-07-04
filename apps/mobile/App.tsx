import { StatusBar } from "expo-status-bar";
import { StyleSheet, Text, View } from "react-native";

// Expo shell (deferred). Shares API contracts/types with web via @farm-friend/contracts.
// Native surface is scaffolded, not built, in Phase 0.
export default function App() {
  return (
    <View style={styles.container}>
      <Text>Farm Friend</Text>
      <Text style={styles.subtitle}>Native surface — deferred, scaffolded.</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  subtitle: { color: "#666", marginTop: 8 },
});
