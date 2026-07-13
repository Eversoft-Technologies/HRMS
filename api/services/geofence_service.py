"""
Geofence validation service for location-based check-in/out.
Uses Haversine formula to calculate distance between two GPS coordinates.
"""
import math


class GeofenceService:
    """Handle geofence validation using GPS coordinates."""

    EARTH_RADIUS_METERS = 6371000  # Earth's radius in meters

    @staticmethod
    def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        """
        Calculate distance between two GPS coordinates using Haversine formula.
        
        Args:
            lat1, lon1: Current coordinates
            lat2, lon2: Geofence center coordinates
            
        Returns:
            Distance in meters
        """
        # Convert to radians
        lat1_rad = math.radians(lat1)
        lon1_rad = math.radians(lon1)
        lat2_rad = math.radians(lat2)
        lon2_rad = math.radians(lon2)

        # Haversine formula
        delta_lat = lat2_rad - lat1_rad
        delta_lon = lon2_rad - lon1_rad

        a = math.sin(delta_lat / 2) ** 2 + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(delta_lon / 2) ** 2
        c = 2 * math.asin(math.sqrt(a))

        distance = GeofenceService.EARTH_RADIUS_METERS * c
        return distance

    @staticmethod
    def is_within_geofence(latitude: float, longitude: float, geofence) -> bool:
        """
        Check if coordinates are within geofence radius.
        
        Args:
            latitude, longitude: Employee's current location
            geofence: GeoFence model instance
            
        Returns:
            bool: True if within geofence, False otherwise
        """
        if not geofence.is_active:
            return False

        distance = GeofenceService.haversine_distance(
            latitude, longitude,
            geofence.latitude, geofence.longitude
        )

        return distance <= geofence.radius_meters


def is_within_geofence(latitude: float, longitude: float, geofence) -> bool:
    """Shorthand for GeofenceService.is_within_geofence()"""
    return GeofenceService.is_within_geofence(latitude, longitude, geofence)
